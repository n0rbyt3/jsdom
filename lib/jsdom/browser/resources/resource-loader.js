"use strict";
const fs = require("fs");
const { parseURL } = require("whatwg-url");
const parse = require("url").parse;
const fetch = require("node-fetch");
const toughCookie = require("tough-cookie");
const { CookieJar } = require("../../../../");
const AbortController = require("abort-controller");
const https = require("https");
const http = require("http");
const HttpProxyAgent = require("http-proxy-agent");
const HttpsProxyAgent = require("https-proxy-agent");
const dataURLFromRecord = require("data-urls").fromURLRecord;
const packageVersion = require("../../../../package.json").version;
const IS_BROWSER = Object.prototype.toString.call(process) !== "[object process]";

module.exports = class ResourceLoader {
  constructor({
    strictSSL = true,
    proxy = undefined,
    userAgent = `Mozilla/5.0 (${process.platform || "unknown OS"}) AppleWebKit/537.36 ` +
                `(KHTML, like Gecko) jsdom/${packageVersion}`
  } = {}) {
    this._strictSSL = strictSSL;
    this._proxy = proxy;
    this._userAgent = userAgent;
  }

  _readDataURL(urlRecord) {
    const dataURL = dataURLFromRecord(urlRecord);
    let timeoutId;
    const promise = new Promise(resolve => {
      timeoutId = setTimeout(resolve, 0, dataURL.body);
    });
    promise.abort = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
    return promise;
  }

  _readFile(filePath) {
    let readableStream;
    let abort; // Native Promises doesn't have an "abort" method.

    /*
     * Creating a promise for two reason:
     *   1. fetch always return a promise.
     *   2. We need to add an abort handler.
    */
    const promise = new Promise((resolve, reject) => {
      readableStream = fs.createReadStream(filePath);
      let data = Buffer.alloc(0);

      abort = reject;

      readableStream.on("error", reject);

      readableStream.on("data", chunk => {
        data = Buffer.concat([data, chunk]);
      });

      readableStream.on("end", () => {
        resolve(data);
      });
    });

    promise.abort = () => {
      readableStream.destroy();
      const error = new Error("request canceled by user");
      error.isAbortError = true;
      abort(error);
    };

    return promise;
  }

  _getAgent(scheme) {
    const agentOpts = { keepAlive: true, rejectUnauthorized: this._strictSSL };
    if (this._proxy) {
      const proxyOpts = { ...parse(this._proxy), ...agentOpts };
      return scheme === "https" ? new HttpsProxyAgent(proxyOpts) : new HttpProxyAgent(proxyOpts);
    }
    return scheme === "https" ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
  }

  _getRequestOptions(urlString, scheme, { cookieJar, referrer, accept = "*/*" }) {
    const requestOptions = {
      redirect: "manual",
      headers: {
        "User-Agent": this._userAgent,
        "Accept-Language": "en",
        "Accept-Encoding": "gzip",
        "Accept": accept
      }
    }

    cookieJar.getCookies(urlString, (err, cookies) => {
      if (cookies.length > 0) {
        requestOptions.headers["Cookie"] = cookies.map(c => c.cookieString()).join("; ");
      }
    });

    if (referrer && !ResourceLoader.IS_BROWSER) {
      requestOptions.headers["Referer"] = referrer;
    }

    if (!ResourceLoader.IS_BROWSER) {
      requestOptions.agent = this._getAgent(scheme);
    }

    return requestOptions;
  }

  _request(urlString, requestOptions, cookieJar) {
    const abortController = new AbortController();
    function abort() {
      if (abortController.signal.aborted) {
        return false;
      }
      abortController.abort();
      return true;
    };
    requestOptions.signal = abortController.signal;

    // TODO: auth?

    const gatheredCookies = [];
    let requestsDone = 0;

    function doFetch(uri) {
      return fetch(uri, requestOptions)
        .then(response => {
          if (response.status > 400) {
            throw new Error(`Unexpected status=${status} for ${urlString}`);
          }

          if (response.headers.has("set-cookie")) {
            const rawHeaders = response.headers.raw();
            if (rawHeaders["set-cookie"] !== undefined) {
              const values = rawHeaders["set-cookie"];
              gatheredCookies.push(values);
            }
          }

          if (response.status >= 300 && response.status < 400) {
            requestsDone++;
            if (requestsDone === 21) {
              throw new Error("too many redirects");
            }
            return doFetch(response.headers.get("location"));
          }

          promise.response = {
            "status": response.status,
            "headers": response.headers
          };
          return response.buffer();
        })
        .then(buffer => {
          if (buffer === null || abortController.signal.aborted) {
            return null;
          }
          return buffer;
        })
        .catch(err => {
          if (abortController.signal.aborted) {
            return null;
          }
          throw err;
      });
    }

    const promise = doFetch(urlString)
      .then(body => {
        if (body !== null && gatheredCookies.length > 0) {
          const setCookieOptions = { ignoreError: true };
          gatheredCookies.forEach(values => {
            values.forEach(cookie => {
              cookieJar.setCookie(cookie, urlString, setCookieOptions);
            });
          });
        }
        return body;
      });

    promise.response = null;
    promise.abort = abort;
    promise.href = urlString;
    promise.getHeader = (name) => {
      return requestOptions.headers[name];
    }

    return promise;
  }

  fetch(urlString, options = {}) {
    const url = parseURL(urlString);

    if (!url) {
      return Promise.reject(new Error(`Tried to fetch invalid URL ${urlString}`));
    }

    switch (url.scheme) {
      case "data": {
        return this._readDataURL(url);
      }

      case "http":
      case "https": {
        options.cookieJar = options.cookieJar || new CookieJar();
        const requestOptions = this._getRequestOptions(urlString, url.scheme, options);
        return this._request(urlString, requestOptions, options.cookieJar);
      }

      case "file": {
        // TODO: Improve the URL => file algorithm. See https://github.com/jsdom/jsdom/pull/2279#discussion_r199977987
        const filePath = urlString
          .replace(/^file:\/\//, "")
          .replace(/^\/([a-z]):\//i, "$1:/")
          .replace(/%20/g, " ");

        return this._readFile(filePath);
      }

      default: {
        return Promise.reject(new Error(`Tried to fetch URL ${urlString} with invalid scheme ${url.scheme}`));
      }
    }
  }
};
