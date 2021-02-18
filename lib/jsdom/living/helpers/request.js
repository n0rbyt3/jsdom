"use strict";
const zlib = require("zlib");
const { parse } = require("url");
const { Cookie } = require("tough-cookie");
const { EventEmitter } = require("events");
const AbortController = require("abort-controller");
const https = require("https");
const http = require("http");
const HttpProxyAgent = require("http-proxy-agent");
const HttpsProxyAgent = require("https-proxy-agent");

function getAgent(protocol, { forever, strictSSL, proxy }) {
  const agentOpts = { keepAlive: forever, rejectUnauthorized: strictSSL };
  if (proxy) {
    const proxyOpts = { ...parse(proxy), ...agentOpts };
    return protocol === "https:" ? new HttpsProxyAgent(proxyOpts) : new HttpProxyAgent(proxyOpts);
  }
  return protocol === "https:" ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
}

function createAuthString(auth) {
  return `{auth.user}:{auth.pass}`;
}

function addUrlToRequestOptions(url, requestOptions) {
  requestOptions.protocol = url.protocol;
  requestOptions.hostname = url.hostname;
  requestOptions.port = url.port;
  requestOptions.path = url.path + (url.search || "");
}

// options:
// - method
// - gzip
// - jar
// - proxy
// - strictSSL
// - forever (keepAlive)
// - headers
// - auth ( obj: user, pass, sendImmediately)
// - maxRedirects (default=5)
// - followRedirect
// - pool
module.exports = function request(urlString, options) {

  if (options === undefined) {
    options = urlString;
    urlString = options.uri;
  }

  const eventEmitter = new EventEmitter();

  let url = parse(urlString);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    process.nextTick(() => eventEmitter.emit("error", new Error(`invalid url "${urlString}"`)));
    return;
  }

  if (url.username !== null && url.password !== null && options.auth && (options.auth.user !== url.username || options.auth.pass !== url.password)) {
    process.nextTick(() => eventEmitter.emit("error", new Error("credentials mismatch, either include them in the url or use \"auth\" option instead")));
    return;
  }

  const headers = options.headers || {};
  if (options.gzip === true) {
    headers["Accept-Encoding"] = "gzip,deflate,br";
  }

  const requestOptions = {
    method: options.method || "GET",
    agent: options.pool !== undefined && options.pool !== false ? options.pool : getAgent(url.protocol, options),
    headers: headers,
  }

  if (options.auth && options.auth.sendImmediately === true) {
    requestOptions.auth = getAuthString(options.auth);
  }

  const abortController = new AbortController();
  requestOptions.signal = abortController.signal;

  let form;
  let redirectsLeft = options.maxRedirects || 5;
  const gatheredCookies = [];

  const result = new Promise((resolve, reject) => {
    const data = [];
    eventEmitter.on("data", chunk => data.push(chunk));
    eventEmitter.once("end", () => resolve(data.length === 1 ? data[0] : Buffer.concat(data)));
    eventEmitter.once("abort", () => resolve(null));

    if (reject !== undefined) {
      eventEmitter.once("error", err => reject(err));
    }
  });

  result.href = url.href;
  result.getHeader = (name) => requestOptions.headers[name];
  result.response = null;
  result.on = (event, listener) => eventEmitter.on(event, listener);
  result.abort = () => abortController.abort();
  result.form = () => {
    if (form === undefined) {
      form = new FormData();
    }
    return form;
  };

  function onAuth(response) {
    requestOptions.auth = getAuthString(options.auth);

    const module = requestOptions.protocol === "https:" ? https : http;
    const request = module.request(requestOptions, onResponse);
    request.on("error", errorHandler);
    request.end();
  }

  function onRedirect(response) {
    if (redirectsLeft-- === 0) {
      errorHandler(new Error("too many redirects"));
      return;
    }

    url = parse(response.headers["location"]);
    if (!url) {
      errorHandler(new Error(`invalid redirect url "${url}"`));
      return;
    }

    requestOptions.headers["Referer"] = result.href;
    result.href = url.href;

    if (requestOptions.protocol !== url.protocol && (options.pool === undefined || options.pool === false)) {
      requestOptions.agent = getAgent(url.protocol, options);
    }

    if (options.jar !== undefined) {
      delete requestOptions.headers["Cookie"];

      options.jar.getCookieString(url.href, (err, cookieString) => {
        if (cookieString !== "") {
          requestOptions.headers["Cookie"] = cookieString;
        }
      });
    }

    eventEmitter.emit("redirect");

    addUrlToRequestOptions(url, requestOptions);
    const module = requestOptions.protocol === "https:" ? https : http;
    const request = module.request(requestOptions, onResponse);
    request.on("error", errorHandler);
    request.end();
  }

  function onData(response) {
    if (options.jar !== undefined) {
      //const noop = () => {};
      const setCookieOptions = { ignoreError: true };
      gatheredCookies.map(headers => {
        headers.map(Cookie.parse).forEach(cookie => {
          options.jar.setCookie(cookie, url.href, setCookieOptions/*, noop*/);
        });
      });
    }

    if (response.statusCode !== 204 && response.statusCode !== 304) {
      let responseStream = response;

      const encoding = response.headers["content-encoding"];
      if (encoding !== undefined) {
        const zlibOptions = {
          flush: zlib.Z_SYNC_FLUSH,
          finishFlush: zlib.Z_SYNC_FLUSH
        }

        if (encoding === "gzip" || encoding === "x-gzip") {
          responseStream = zlib.createGunzip(zlibOptions);
          response.pipe(responseStream);
        } else if (encoding === "deflate") {
          responseStream = zlib.createInflate(zlibOptions);
          response.pipe(responseStream);
        } else if (encoding === "br") {
          responseStream = zlib.createBrotliDecompress(zlibOptions);
          response.pipe(responseStream);
        }
      }

      responseStream.on("data", chunk => eventEmitter.emit("data", chunk));
      responseStream.once("end", () => eventEmitter.emit("end"));
      return;
    }

    eventEmitter.emit("end");
  }

  function onResponse(response) {
    if (abortController.signal.aborted) {
      result.response = null;
      eventEmitter.emit("abort");
      return;
    }

    result.response = {
      request: {
        uri: url
      },
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      headers: response.headers,
      on: (event, listener) => response.on(event, listener)
    };

    const cookieHeader = response.headers["set-cookie"];
    if (options.jar !== undefined && cookieHeader !== undefined) {
      gatheredCookies.push(cookieHeader);
    }

    //eventEmitter.emit("response", result.response);

    if (options.auth && requestOptions.auth === undefined && response.statusCode === 401 && response.headers["www-authenticate"] !== undefined) {
      onAuth(response);
      return;
    }

    if (options.followRedirect !== false && response.statusCode >= 300 && response.statusCode < 400 && response.statusCode !== 304) {
      onRedirect(response);
      return;
    }

    eventEmitter.emit("response", result.response);
    onData(response);
  };

  function errorHandler(error) {
    // do not emit errors on user-abort
    if (!abortController.signal.aborted) {
      eventEmitter.emit("error", error);
    }
  };

  //process.nextTick(() => {
    eventEmitter.emit("request");

    if (form !== undefined) {
      requestOptions.method = "POST";
      requestOptions.headers = form.getHeaders(requestOptions.headers);
    }

    if (options.jar !== undefined) {
      options.jar.getCookieString(url.href, (err, cookieString) => {
        if (cookieString !== "") {
          requestOptions.headers["Cookie"] = cookieString;
        }
      });
    }

    addUrlToRequestOptions(url, requestOptions);
    const module = requestOptions.protocol === "https:" ? https : http;
    const request = module.request(requestOptions, onResponse);

    if (form !== undefined) {
      form.pipe(request);
    }

    request.on("error", errorHandler);
    request.end();
  //});

  return result;
};
