"use strict";
const request = require("./request");
const { CookieJar } = require("../../../../");

const jar = new CookieJar();
const r = request("http://www.knuddels.de/", { gzip: true, forever: true, jar: jar });
r.on("request", () => console.log("request started"));
r.on("response", response => console.log("response received"));
r.on("end", () => console.log(`request end, jar=${jar}`));
r.on("error", err => console.log(`event error: ${err}`));
r.then(body => console.log(`body: ${body}`)).catch(err => console.log(`promise error: ${err}`));
