"use strict";
const fs = require("fs");
const fetch = require("node-fetch");
const toughCookie = require("tough-cookie");
const { CookieJar } = require("../../../../");
const AbortController = require("abort-controller");
const https = require("https");
const http = require("http");
const HttpProxyAgent = require("http-proxy-agent");
const HttpsProxyAgent = require("https-proxy-agent");
const { EventEmitter } = require("events");
const { URL } = require("whatwg-url");
const parseDataURL = require("data-urls");
const DOMException = require("domexception/webidl2js-wrapper");

const ProgressEvent = require("../generated/ProgressEvent");

const { fireAnEvent } = require("../helpers/events");

const headerListSeparatorRegexp = /,[ \t]*/;
const simpleMethods = new Set(["GET", "HEAD", "POST"]);
const simpleHeaders = new Set(["accept", "accept-language", "content-language", "content-type"]);
const preflightHeaders = new Set([
  "access-control-expose-headers",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-allow-origin"
]);

const READY_STATES = exports.READY_STATES = Object.freeze({
  UNSENT: 0,
  OPENED: 1,
  HEADERS_RECEIVED: 2,
  LOADING: 3,
  DONE: 4
});

function getRequestHeader(requestHeaders, header) {
  const lcHeader = header.toLowerCase();
  const keys = Object.keys(requestHeaders);
  let n = keys.length;
  while (n--) {
    const key = keys[n];
    if (key.toLowerCase() === lcHeader) {
      return requestHeaders[key];
    }
  }
  return null;
}

function updateRequestHeader(requestHeaders, header, newValue) {
  const lcHeader = header.toLowerCase();
  const keys = Object.keys(requestHeaders);
  let n = keys.length;
  while (n--) {
    const key = keys[n];
    if (key.toLowerCase() === lcHeader) {
      requestHeaders[key] = newValue;
    }
  }
}

function dispatchError(xhr) {
  const errMessage = xhr.properties.error;
  requestErrorSteps(xhr, "error", DOMException.create(xhr._globalObject, [errMessage, "NetworkError"]));

  if (xhr._ownerDocument) {
    const error = new Error(errMessage);
    error.type = "XMLHttpRequest"; // TODO this should become "resource loading" when XHR goes through resource loader

    xhr._ownerDocument._defaultView._virtualConsole.emit("jsdomError", error);
  }
}

function validCORSHeaders(xhr, response, flag, properties, origin) {
  const acaoStr = response.headers["access-control-allow-origin"];
  const acao = acaoStr ? acaoStr.trim() : null;
  if (acao !== "*" && acao !== origin) {
    properties.error = "Cross origin " + origin + " forbidden";
    dispatchError(xhr);
    return false;
  }
  const acacStr = response.headers["access-control-allow-credentials"];
  const acac = acacStr ? acacStr.trim() : null;
  if (flag.withCredentials && acac !== "true") {
    properties.error = "Credentials forbidden";
    dispatchError(xhr);
    return false;
  }
  return true;
}

function validCORSPreflightHeaders(xhr, response, flag, properties) {
  if (!validCORSHeaders(xhr, response, flag, properties, properties.origin)) {
    return false;
  }
  const acahStr = response.headers["access-control-allow-headers"];
  const acah = new Set(acahStr ? acahStr.trim().toLowerCase().split(headerListSeparatorRegexp) : []);
  const forbiddenHeaders = Object.keys(flag.requestHeaders).filter(header => {
    const lcHeader = header.toLowerCase();
    return !simpleHeaders.has(lcHeader) && !acah.has(lcHeader);
  });
  if (forbiddenHeaders.length > 0) {
    properties.error = "Headers " + forbiddenHeaders + " forbidden";
    dispatchError(xhr);
    return false;
  }
  return true;
}

function requestErrorSteps(xhr, event, exception) {
  const { flag, properties, upload } = xhr;

  xhr.readyState = READY_STATES.DONE;
  properties.send = false;

  setResponseToNetworkError(xhr);

  if (flag.synchronous) {
    throw exception;
  }

  fireAnEvent("readystatechange", xhr);

  if (!properties.uploadComplete) {
    properties.uploadComplete = true;

    if (properties.uploadListener) {
      fireAnEvent(event, upload, ProgressEvent, { loaded: 0, total: 0, lengthComputable: false });
      fireAnEvent("loadend", upload, ProgressEvent, { loaded: 0, total: 0, lengthComputable: false });
    }
  }

  fireAnEvent(event, xhr, ProgressEvent, { loaded: 0, total: 0, lengthComputable: false });
  fireAnEvent("loadend", xhr, ProgressEvent, { loaded: 0, total: 0, lengthComputable: false });
}

function setResponseToNetworkError(xhr) {
  const { properties } = xhr;
  properties.responseCache = properties.responseTextCache = properties.responseXMLCache = null;
  properties.responseHeaders = {};
  xhr.status = 0;
  xhr.statusText = "";
}

// return a "request" client object or an event emitter matching the same behaviour for unsupported protocols
// the callback should be called with a "request" response object or an event emitter matching the same behaviour too
function createClient(xhr) {
  const { flag, properties } = xhr;
  const urlObj = new URL(flag.uri);
  const uri = urlObj.href;
  const ucMethod = flag.method.toUpperCase();

  const { requestManager } = flag;

  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = {};
  response.request = { uri: urlObj };

  const client = new EventEmitter();

  if (urlObj.protocol === "file:") {
    const filePath = urlObj.pathname
      .replace(/^file:\/\//, "")
      .replace(/^\/([a-z]):\//i, "$1:/")
      .replace(/%20/g, " ");

    const readableStream = fs.createReadStream(filePath, { encoding: null });

    readableStream.on("data", chunk => {
      response.emit("data", chunk);
      client.emit("data", chunk);
    });

    readableStream.on("end", () => {
      response.emit("end");
      client.emit("end");
    });

    readableStream.on("error", err => {
      client.emit("error", err);
    });

    client.abort = () => {
      readableStream.destroy();
      client.emit("abort");
    };

    if (requestManager) {
      const req = {
        abort() {
          properties.abortError = true;
          xhr.abort();
        }
      };
      requestManager.add(req);
      const rmReq = requestManager.remove.bind(requestManager, req);
      client.on("abort", rmReq);
      client.on("error", rmReq);
      client.on("end", rmReq);
    }

    process.nextTick(() => client.emit("response", response));

    return client;
  }

  if (urlObj.protocol === "data:") {
    let buffer;
    try {
      const parsed = parseDataURL(uri);
      const contentType = parsed.mimeType.toString();
      buffer = parsed.body;
      response.headers["content-type"] = contentType;
    } catch (err) {
      process.nextTick(() => client.emit("error", err));
      return client;
    }

    client.abort = () => {
      // do nothing
    };

    process.nextTick(() => {
      client.emit("response", response);
      process.nextTick(() => {
        response.emit("data", buffer);
        client.emit("data", buffer);
        response.emit("end");
        client.emit("end");
      });
    });

    return client;
  }

  const requestHeaders = {};

  for (const header in flag.requestHeaders) {
    requestHeaders[header] = flag.requestHeaders[header];
  }

  if (getRequestHeader(flag.requestHeaders, "referer") === null) {
    requestHeaders.Referer = flag.referrer;
  }
  if (getRequestHeader(flag.requestHeaders, "user-agent") === null) {
    requestHeaders["User-Agent"] = flag.userAgent;
  }
  if (getRequestHeader(flag.requestHeaders, "accept-language") === null) {
    requestHeaders["Accept-Language"] = "en";
  }
  if (getRequestHeader(flag.requestHeaders, "accept-encoding") === null) {
    requestHeaders["Accept-Encoding"] = "gzip,deflate";
  }
  if (getRequestHeader(flag.requestHeaders, "accept") === null) {
    requestHeaders.Accept = "*/*";
  }

  const crossOrigin = flag.origin !== urlObj.origin;
  if (crossOrigin) {
    requestHeaders.Origin = flag.origin;
  }

  const agentOpts = { keepAlive: true, rejectUnauthorized: flag.strictSSL };
  let agent;
  if (flag.proxy) {
    const proxyOpts = { ...parse(flag.proxy), ...agentOpts };
    agent = urlObj.protocol === "https:" ? new HttpsProxyAgent(proxyOpts) : new HttpProxyAgent(proxyOpts);
  } else {
    agent = urlObj.protocol === "https:" ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
  }

  const options = {
    method: flag.method,
    headers: requestHeaders,
    redirect: "manual", // required to emit "redirected" event
    agent: agent
  };

  if (flag.cookieJar && (!crossOrigin || flag.withCredentials)) {
    flag.cookieJar.getCookies(uri, (err, cookies) => {
      if (cookies.length > 0) {
        requestHeaders["Cookie"] = cookies.map(c => c.cookieString()).join("; ");
      }
    });
  }

  const abortController = new AbortController();
  client.abort = () => {
    abortController.abort();
  }
  options.signal = abortController.signal;

  const { body } = flag;
  const hasBody = body !== undefined &&
                  body !== null &&
                  body !== "" &&
                  !(ucMethod === "HEAD" || ucMethod === "GET");

  if (hasBody && !flag.formData) {
    options.body = body;
  }

  if (hasBody && getRequestHeader(flag.requestHeaders, "content-type") === null) {
    requestHeaders["Content-Type"] = "text/plain;charset=UTF-8";
  }

  const gatheredCookies = [];
  let requestsDone = 0;

  function doRequestTo(uri) {
    fetch(uri, options)
      .then(resp => {
        if (abortController.signal.aborted) {
           client.emit("abort");
           return;
        }

        if (resp.status === 401 && flag.auth && requestHeaders["Authorization"] === undefined && resp.headers.has('www-authenticate')) {
          // retry with authentication
          const authHeader = "Basic " + Buffer.from(`${flag.auth.user}:${flag.auth.pass}`).toString("base64");
          requestHeaders["Authorization"] = authHeader;

          doRequestTo(uri);
          return;
        }

        // track cookies over redirects
        if (resp.headers.has("set-cookie")) {
          const values = resp.headers.raw()["set-cookie"];
          gatheredCookies.push(values);
        }

        // manually check for redirection and follow them 21 times
        if (resp.status >= 300 && resp.status < 400) {
          requestsDone++;
          if (requestsDone === 21) {
            throw new Error(`Exceeded maxRedirects. Probably stuck in a redirect loop ${uri}`);
          }
          client.emit("redirect");
          doRequestTo(resp.headers.get("location"));
          return;
        }

        // append tracked cookies to final uri
        if (gatheredCookies.length > 0) {
          const setCookieOptions = { ignoreError: true };
          flag.cookieJar = flag.cookieJar || new CookieJar();
          gatheredCookies.forEach(values => {
            values.forEach(value => {
              flag.cookieJar.setCookie(value, uri, setCookieOptions);
            });
          });
        }

        // TODO: form handling, see old code

        response.statusCode = resp.status;
        resp.headers.forEach((value, key) => {
          response.headers[key] = value;
        });
        client.emit("response", response);

        return resp.buffer();
      })
      .then(buffer => {
        // undefined in case of redirect, auth requested
        // or signal.aborted
        if (buffer !== undefined) {
          response.emit("data", buffer);
          client.emit("data", buffer);
          response.emit("end");
          client.emit("end");
        }
      })
      .catch(err => {
        if (abortController.signal.aborted) {
          client.emit("abort");
          return;
        }
        client.emit("error", err);
      });
  }

  function doRequest() {
    doRequestTo(uri);
  }

  const nonSimpleHeaders = Object.keys(flag.requestHeaders)
    .filter(header => !simpleHeaders.has(header.toLowerCase()));

  if (crossOrigin && (!simpleMethods.has(ucMethod) || nonSimpleHeaders.length > 0 || properties.uploadListener)) {
    const preflightRequestHeaders = [];
    for (const header in requestHeaders) {
      // the only existing request headers the cors spec allows on the preflight request are Origin and Referrer
      const lcHeader = header.toLowerCase();
      if (lcHeader === "origin" || lcHeader === "referrer") {
        preflightRequestHeaders[header] = requestHeaders[header];
      }
    }

    preflightRequestHeaders["Access-Control-Request-Method"] = flag.method;
    if (nonSimpleHeaders.length > 0) {
      preflightRequestHeaders["Access-Control-Request-Headers"] = nonSimpleHeaders.join(", ");
    }

    preflightRequestHeaders["User-Agent"] = flag.userAgent;

    flag.preflight = true;

    // TODO: check pool option
    const preflightOptions = {
      method: "OPTIONS",
      headers: preflightRequestHeaders,
      redirect: "manual",
      //pool: flag.pool,
      agent: agent,
      signal: abortController.signal,
    };

    fetch(uri, preflightOptions)
      .then(resp => {
        // don't send the real request if the preflight request returned an error
        if (resp.status < 200 || resp.status > 299) {
          throw new Error("Response for preflight has invalid HTTP status code " + resp.status);
        }
        // don't send the real request if we aren't allowed to use the headers
        if (!validCORSPreflightHeaders(xhr, resp, flag, properties)) {
          // TODO: transform into error and throw
          setResponseToNetworkError(xhr);
          throw new Error("TODO");
        }
        doRequest();
      })
      .catch(err => {
        if (abortController.signal.abort) {
          client.emit("abort");
          return;
        }
        client.emit("error", err);
      });
  } else {
    doRequest();
  }

  if (requestManager) {
    const req = {
      abort() {
        properties.abortError = true;
        xhr.abort();
      }
    };
    requestManager.add(req);
    const rmReq = requestManager.remove.bind(requestManager, req);
    client.on("abort", rmReq);
    client.on("error", rmReq);
    client.on("end", rmReq);
  }

  return client;
}

exports.headerListSeparatorRegexp = headerListSeparatorRegexp;
exports.simpleHeaders = simpleHeaders;
exports.preflightHeaders = preflightHeaders;
exports.getRequestHeader = getRequestHeader;
exports.updateRequestHeader = updateRequestHeader;
exports.dispatchError = dispatchError;
exports.validCORSHeaders = validCORSHeaders;
exports.requestErrorSteps = requestErrorSteps;
exports.setResponseToNetworkError = setResponseToNetworkError;
exports.createClient = createClient;
