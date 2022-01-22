const chunk = require('lodash.chunk');
const colors = require('ansi-colors');
const crypto = require('crypto');
const fancyLog = require('fancy-log');
const fs = require('fs');
const mime = require('mime-types');
const path = require('path');
const PluginError = require('plugin-error');
const Stream = require('stream');
const through = require('through2');
const Vinyl = require('vinyl');
const zlib = require('zlib');
const { pascalCase } = require('pascal-case');
const { S3 } = require('@aws-sdk/client-s3');

const PLUGIN_NAME = 'gulp-awspublish';

module.exports.reporter = function reporter(options = {}) {
  const stream = through.obj(function (file, enc, cb) {
    if (!file.s3) return cb(null, file);
    if (!file.s3.state) return cb(null, file);
    if (options.states && options.states.indexOf(file.s3.state) === -1)
      return cb(null, file);

    let state = '[' + file.s3.state + ']';
    state = state.padEnd(8);

    switch (file.s3.state) {
      case 'create':
        state = colors.green(state);
        break;
      case 'delete':
        state = colors.red(state);
        break;
      default:
        state = colors.cyan(state);
        break;
    }

    fancyLog(state, file.s3.path);
    cb(null, file);
  });

  // force flowing mode
  // @see http://nodejs.org/docs/latest/api/stream.html#stream_event_end
  // @see https://github.com/pgherveou/gulp-awspublish/issues/13
  stream.resume();
  return stream;
};

module.exports.gzip = function gzip(options = {}) {
  if (!options.ext) options.ext = '';

  return through.obj(function (file, enc, cb) {
    // Do nothing if no contents
    if (file.isNull()) return cb();

    // streams not supported
    if (file.isStream()) {
      this.emit(
        'error',
        new PluginError(PLUGIN_NAME, 'Stream content is not supported')
      );
      return cb();
    }

    // check if file.contents is a `Buffer`
    if (file.isBuffer()) {
      initFile(file);

      // zip file
      zlib.gzip(file.contents, options, function (err, buf) {
        if (err) return cb(err);
        if (options.smaller && buf.length >= file.contents.length)
          return cb(err, file);
        // add content-encoding header
        file.s3.headers['Content-Encoding'] = 'gzip';
        file.unzipPath = file.path;
        file.path += options.ext;
        file.s3.path += options.ext;
        file.contents = buf;
        cb(err, file);
      });
    }
  });
};

module.exports.create = function create(AWSConfig, cacheOptions) {
  return new Publisher(AWSConfig, cacheOptions);
};

function Publisher(AWSConfig, cacheOptions) {
  if (!AWSConfig.region) {
    AWSConfig.region = 'aws-global';
  }

  const client = new S3(AWSConfig);
  const { Bucket } = client.config.params;

  if (!Bucket) {
    throw new Error('Missing `params.Bucket` config value.');
  }

  // init Cache file
  const cacheFilename =
    cacheOptions && cacheOptions.cacheFileName
      ? cacheOptions.cacheFileName
      : '.awspublish-' + Bucket;

  // load cache
  const cacheObject = (function () {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', cacheFilename), 'utf8')
      );
    } catch (err) {
      return {};
    }
  })();

  return {
    cache,
    cacheFilename,
    cacheObject,
    client,
    publish,
    sync,
  };

  /**
   * create a through stream that save file in cache
   *
   * @return {Stream}
   * @api public
   */
  function cache() {
    let counter = 0;
    const stream = through.obj(function (file, enc, cb) {
      if (file.s3 && file.s3.path) {
        // do nothing for file already cached
        if (file.s3.state === 'cache') return cb(null, file);

        // remove deleted
        if (file.s3.state === 'delete') {
          delete cacheObject[file.s3.path];

          // update others
        } else if (file.s3.etag) {
          cacheObject[file.s3.path] = file.s3.etag;
        }

        // save cache every 10 files
        if (++counter % 10) saveCache();
      }

      cb(null, file);
    });

    stream.on('finish', saveCache);

    return stream;
  }

  function saveCache() {
    fs.writeFileSync(cacheFilename, JSON.stringify(cacheObject));
  }

  /**
   * create a through stream that publish files to s3
   * @headers {Object} headers additional headers to add to s3
   * @options {Object} options option hash
   *
   * available options are:
   * - force {Boolean} force upload
   * - noAcl: do not set x-amz-acl by default
   * - simulate: debugging option to simulate s3 upload
   * - createOnly: skip file updates
   *
   * @return {Stream}
   * @api public
   */
  function publish(headers = {}, options = { force: false }) {
    // add public-read header by default
    if (!headers['x-amz-acl'] && !options.noAcl)
      headers['x-amz-acl'] = 'public-read';

    return through.obj(function (file, enc, cb) {
      // Do nothing if no contents
      if (file.isNull()) return cb();

      // streams not supported
      if (file.isStream()) {
        this.emit(
          'error',
          new PluginError(PLUGIN_NAME, 'Stream content is not supported')
        );
        return cb();
      }

      // check if file.contents is a `Buffer`
      if (file.isBuffer()) {
        initFile(file);

        // calculate etag
        const etag = '"' + md5Hash(file.contents) + '"';

        // delete - stop here
        if (file.s3.state === 'delete') return cb(null, file);

        // check if file is identical as the one in cache
        if (!options.force && cacheObject[file.s3.path] === etag) {
          file.s3.state = 'cache';
          return cb(null, file);
        }

        // add content-type header
        if (!file.s3.headers['Content-Type'])
          file.s3.headers['Content-Type'] = getContentType(file);

        // add content-length header
        if (!file.s3.headers['Content-Length'])
          file.s3.headers['Content-Length'] = file.contents.length;

        // add extra headers
        for (let header in headers) file.s3.headers[header] = headers[header];

        if (options.simulate) return cb(null, file);

        // get s3 headers
        client.headObject(
          { Bucket, Key: file.s3.path },
          function (err, res = {}) {
            //ignore 403 and 404 errors since we're checking if a file exists on s3
            if (err && [403, 404].indexOf(err['$response'].statusCode) < 0)
              return cb(err);

            // skip: no updates allowed
            const noUpdate = options.createOnly && res.ETag;

            // skip: file are identical
            const noChange = !options.force && res.ETag === etag;

            if (noUpdate || noChange) {
              file.s3.state = 'skip';
              file.s3.etag = etag;
              file.s3.date = new Date(res.LastModified);
              cb(err, file);

              // update: file are different
            } else {
              file.s3.state = res.ETag ? 'update' : 'create';

              client.putObject(toAwsParams(Bucket, file), function (err) {
                if (err) return cb(err);
                file.s3.date = new Date();
                file.s3.etag = etag;
                cb(err, file);
              });
            }
          }
        );
      }
    });
  }

  function sync(prefix = '', whitelistedFiles = []) {
    const stream = new Stream.Transform({ objectMode: true });
    const newFiles = {};

    // push file to stream and add files to s3 path to list of new files
    stream._transform = function (file, encoding, cb) {
      newFiles[file.s3.path] = true;
      this.push(file);
      cb();
    };

    stream._flush = async function (cb) {
      const toDelete = [];
      let objects = [];
      let hasMore = true;
      let token = void 0;

      while (hasMore) {
        const { Contents, NextContinuationToken } = await client.listObjectsV2({
          Bucket,
          Prefix: prefix,
          MaxKeys: 1,
          ContinuationToken: token,
        });
        objects = objects.concat(Contents);
        token = NextContinuationToken;
        hasMore = !!NextContinuationToken;
      }

      for (const { Key } of objects) {
        if (newFiles[Key]) continue;
        if (!fileShouldBeDeleted(Key, whitelistedFiles)) continue;
        const deleteFile = new Vinyl({});
        deleteFile.s3 = {
          path: Key,
          state: 'delete',
          headers: {},
        };

        stream.push(deleteFile);
        toDelete.push(Key);
      }

      Promise.all(
        buildDeleteMultiple(toDelete).map(function (each) {
          return client.deleteObjects(each).promise();
        })
      )
        .then(function () {
          cb();
        })
        .catch(function (e) {
          cb(e);
        });
    };

    return stream;
  }
}

/**
 * calculate file hash
 * @param  {Buffer} buf
 * @return {String}
 *
 * @api private
 */
function md5Hash(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/**
 * init file s3 hash
 * @param  {Vinyl} file file object
 *
 * @return {Vinyl} file
 * @api private
 */
function initFile(file) {
  if (!file.s3) {
    file.s3 = {};
    file.s3.headers = {};
    file.s3.path = file.relative.replace(/\\/g, '/');
  }
  return file;
}

/**
 * Determine the content type of a file based on charset and mime type.
 * @param  {Object} file
 * @return {String}
 *
 * @api private
 */
function getContentType(file) {
  const mimeType =
    mime.lookup(file.unzipPath || file.path) || 'application/octet-stream';
  const charset = mime.charset(mimeType);

  return charset ? mimeType + '; charset=' + charset.toLowerCase() : mimeType;
}

/**
 * Turn the HTTP style headers into AWS Object params
 */
function toAwsParams(bucket, file) {
  const params = {};
  const headers = file.s3.headers || {};

  for (let header in headers) {
    if (header === 'x-amz-acl') {
      params.ACL = headers[header];
    } else if (header === 'Content-MD5') {
      params.ContentMD5 = headers[header];
    } else {
      params[pascalCase(header)] = headers[header];
    }
  }

  params.Bucket = bucket;
  params.Key = file.s3.path;
  params.Body = file.contents;

  return params;
}

/**
 * init file s3 hash
 * @param  {String} key filepath
 * @param  {Array} whitelist list of expressions that match against files that should not be deleted
 *
 * @return {Boolean} shouldDelete whether the file should be deleted or not
 * @api private
 */
function fileShouldBeDeleted(key, whitelist) {
  for (let expr of whitelist) {
    if (expr instanceof RegExp) {
      if (expr.test(key)) {
        return false;
      }
    } else if (typeof expr === 'string') {
      if (expr === key) {
        return false;
      }
    } else {
      throw new Error(
        'whitelist param can only contain regular expressions or strings'
      );
    }
  }
  return true;
}

function buildDeleteMultiple(Bucket, keys = []) {
  const deleteObjects = keys.map(function (Key) {
    return { Key };
  });
  const chunks = chunk(deleteObjects, 1000);
  return chunks.map(function (Objects) {
    return {
      Bucket,
      Delete: {
        Objects,
      },
    };
  });
}

module.exports._buildDeleteMultiple = buildDeleteMultiple;
module.exports._toAwsParams = toAwsParams;
