// tools that can be used to answer questions

import env from "dotenv";
env.config();

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import util from "node:util";

import yaml from 'yaml';
import JSON5 from 'json5';
import jgexml from 'jgexml/xml2json.js';
import { Parser } from "expr-eval";
import metaFetcher from 'meta-fetcher';
import { svg2png, initialize } from 'svg2png-wasm';
import jsFiddle from 'jsfiddle';
import { v4 as uuidv4 } from 'uuid';
import open from 'open';
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';
import { isWithinTokenLimit } from 'gpt-tokenizer';
import { Image, Video, Gif } from 'termview';
import pdf from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import { request, gql } from "graphql-request";

import { colour } from "./colour.mjs";

const TOKEN_LIMIT = (parseInt(process.env.TOKEN_LIMIT,10)/2.0)||2048; // TODO

const scriptResult = { prompt: '', chatResponse: '', chatEnvironment: { retrievedText: '' } };
vm.createContext(scriptResult);

const html2md = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true });
const gfm = turndownPluginGfm.gfm
const tables = turndownPluginGfm.tables
const strikethrough = turndownPluginGfm.strikethrough

export let history = '';
export const debug = () => process.env.DEBUG;
let apiServer = '';
let RESPONSE_LIMIT;
let blocked = new Map();

const pluginTemplate = fs.readFileSync("./plugin.txt", "utf8");

// Use the gfm, table and strikethrough plugins
html2md.use([gfm, tables, strikethrough]);
html2md.remove(['aside', 'script', 'style', 'frame', 'iframe', 'applet', 'audio', 'canvas', 'datagrid', 'table']); // some of these may be controversial

const token_cache = new Map();
export let fiddleSrc = "";

export const setResponseLimit = (limit) => {
  RESPONSE_LIMIT = limit;
};

export const setPrompt = (prompt) => {
  scriptResult.prompt = prompt;
  return prompt;
};

export const setRetrievedText = (received) => {
  scriptResult.chatEnvironment.retrievedText = received;
  return received;
};

export const clean = (text) => {
  text = text.replace(/\u001b\[.*?m/g, "");
  return text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");
};

const truncate = (text) => {
  text = text.substring(0,TOKEN_LIMIT*2);
  let count = 0;
  let scythe = 0.9;
  while (!isWithinTokenLimit(history + '\n' + text, TOKEN_LIMIT - RESPONSE_LIMIT, token_cache)) {
    count++;
    if (count === 1) {
      process.stdout.write(`${colour.magenta}(Truncating)${colour.normal}`);
    }
    text = text.substring(0,Math.round(text.length*scythe));
    if (scythe > 0.1) {
      scythe = scythe - 0.1;
    }
    else {
      scythe = scythe * 0.66;
    }
  }
  return text;
};

const nop = () => { return true };

// use Microsoft Bing to answer the question
const bingSearch = async (question) => {
  let hits = 0;
  return await fetch(
    `https://api.bing.microsoft.com/v7.0/search?q=${escape(question)}`, { redirect: 'follow', headers: {"Ocp-Apim-Subscription-Key": process.env.BING_API_KEY } })
    .then((res) => {
      if (res.ok) return res.json()
      else {
        console.log(`${colour.red}${res.status} - ${http.STATUS_CODES[res.status]}${colour.normal}`);
        return {};
      }
    })
    .then((res) => {
        let results = 'Results:\n';
        // try to pull the answer from various components of the response
        if (res && res.images && res.images.value) {
          for (let value of res.images.value) {
            hits++;
            results += `${value.name}:\n${value.description}\nTo retrieve, use this URL ${value.contentUrl} with the image tool.\n`;
          }
        }
        if (res && res.videos && res.videos.value) {
          for (let value of res.videos.value) {
            hits++;
            results += `${value.name}:\n${value.description}\nTo retrieve, use this URL: ${value.contentUrl} with the video tool.\n`;
          }
        }
        if (res && res.webPages && res.webPages.value) {
          for (let value of res.webPages.value) {
            hits++;
            if (value.url.toLowerCase().indexOf('.pdf') > 0) {
              results += `${value.name}:\n${value.snippet}\nFor further details, retrievepdf this URL: ${value.url}\n`;
            }
            if (value.url.toLowerCase().indexOf('.docx') > 0) {
              results += `${value.name}:\n${value.snippet}\nFor further details, retrievedoc this URL: ${value.url}\n`;
            }
            else {
              results += `${value.name}:\n${value.snippet}\nFor further details, retrieve this URL: ${value.url}\n`;
            }
          }
        }
        if (results.length < 10) {
          results += 'None found.';
        }
        results += '\nEnd of results.'
        if (debug()) console.log(`${colour.yellow}${results}${colour.normal}`)
        else console.log(`${colour.cyan}Found ${hits} search results.${colour.normal}`);
        return results;
      });
};

const retrieveHTML = async (url) => {
  return await retrieveURL(url, true);
}

const retrieveURL = async (url, skipTurndown) => {
  if (url.startsWith('"')) {
    url = url.replace(/\\"/g, '');
  }
  if (url.startsWith("'")) {
    url = url.replace(/\\'/g, '');
  }
  if (url.toLowerCase().indexOf('.pdf') > 0) {
    return await tools.readpdf.execute(url);
  }
  if (url.toLowerCase().indexOf('.docx') > 0) {
    return await tools.readdoc.execute(url);
  }
  if (url.toLowerCase().indexOf('.svg') > 0) {
    return await tools.image.execute(url);
  }
  let hoist = { ok: false, status: 418 };
  await fetch(url, { redirect: 'follow' })
    .then((res) => {
      hoist = res;
      return res.text()
    })
    .then((txt) => {
      let text = txt
      if (!skipTurndown) text = html2md.turndown(text);
      text = truncate(text);
      setRetrievedText(text);
      if (debug()) console.log(`${colour.cyan}${text}${colour.normal}`);
      return text;
    })
    .catch((ex) => {
      console.log(`${colour.red}${ex.message} - ${http.STATUS_CODES[hoist.status]}${colour.normal}`);
    });
  };

const retrieveMetadata = async (url) => {
  try {
    const res = await metaFetcher(url);
    const result = yaml.stringify(res);
    if (debug()) console.log(`${colour.yellow}${result}${colour.normal}`)
    return setRetrievedText(result);
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
  }
  return 'No metadata found.'
};

const retrieveImage = async (url) => {
  if (process.env.GUI) {
    open(url);
    return "The image was displayed successfully in the browser.";
  }
  try {
    if (url.indexOf('.svg') >= 0) {
      const res = await fetch(url, { redirect: 'follow', headers: { "Accept": "image/svg+xml" } });
      const svg = await res.text();
      const body = await svg2png(svg);
      fs.writeFileSync("./temp.png", body);
      process.nextTick(async () => { // idk why this is necessary, but it is
        const render = await Image(`http://localhost:${process.env.PORT}/temp.png`);
        console.log(`${render}${colour.normal}`);
      });
    }
    else if (url.indexOf('.gif') >= 0) {
      process.nextTick(async () => { // ditto
        const render = await Gif(url);
        console.log(`${render}${colour.normal}`);
      });
    }
    else {
      process.nextTick(async () => { // ditto
        const render = await Image(url);
        console.log(`${render}${colour.normal}`);
      });
    }
    return "The image was displayed successfully in the terminal.";
  }
  catch (ex) {
    return `That URL returned an error: ${ex.message}. Try again if you have more URLs.`;
  }
};

const retrieveVideo = async (url) => {
  let res = { ok: false, status: 418 };
  try {
    if (url.indexOf('.gif') >= 0) {
      const render = await Gif(url);
      console.log(render);
    }
    else {
      const render = await Video(url);
      console.log(render);
    }
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
    return `That video could not be displayed. Try again if you have more URLs.`;
  }
};

const install = async (domain) => {
  domain = domain.split('the ').join('');
  domain = domain.split(' plugin').join('');
  domain = domain.replace('http://','');
  domain = domain.replace('https://','');
  const pluginManifest = `https://${domain}/.well-known/ai-plugin.json`;
  let res = { ok: false, status: 404 };
  let plugin;
  let question = '';
  try {
    res = await fetch(pluginManifest, { redirect: 'follow' });
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
  }
  if (res.ok) {
    plugin = await res.json();
    if (debug()) console.log(`${colour.yellow}${yaml.stringify(plugin)}${colour.normal}`)
    if (plugin.api.type === 'openapi') {
      res = { ok: false, status: 404 };
      try {
        res = await fetch(plugin.api.url, { redirect: 'follow' });
      }
      catch (ex) {}
      if (res.ok) {
        const apiDef = await res.text();
        try {
          const openApi = yaml.parse(apiDef);
          if (openApi && openApi.openapi && openApi.servers) {
            apiServer = openApi.servers[0].url;
            // TODO substitute all the variable default values
          }
          const openApiYaml = yaml.stringify(openApi);
          question = pluginTemplate + '\n\n' + openApiYaml;
          console.log(`${colour.green}Successfully installed the ${domain} plugin and API.${colour.normal}`);
        }
        catch (ex) {
          console.warn(`${colour.red}${ex.message}${colour.normal}`);
        }
      }
      else {
        console.log(`${colour.red}Failed to fetch API definition!${colour.normal}`);
      }
    }
  }
  else {
    console.log(`${colour.red}Failed to fetch plugin manifest!${colour.normal}`);
  }
  return question;
};

const apicall = async (endpoint) => {
  const components = endpoint.split(':');
  const method = components[0].toLowerCase();
  components.shift();
  const remaining = components.join(':').trim();
  let path = remaining.split('#')[0];
  if (!path.startsWith('http')) {
    path = apiServer+path;
  }
  const hdrs = remaining.split('#')[1];
  let headers = {};
  if (hdrs) try {
    headers = JSON.parse(hdrs);
  }
  catch (ex) {
    console.log(`${colour.red}Could not parse headers map JSON${colour.normal}`);
  }
  if (!headers.Accept && !headers.accept) {
    headers.accept = 'application/json';
  }
  headers['User-Agent'] = 'postman-open-technologies/BingChain/1.1.0';
  console.log('Using the',method,'method to call the',path,'endpoint');
  let res = { ok: false, status: 404 };
  try {
    res = await fetch(path,{ method, headers });
  }
  catch (ex) {
    console.log(`${colour.red}${method} ${path} - ${ex.message}${colour.normal}`);
  }
  if (res.ok) {
    const ct = res.headers['content-type'];
    console.log(`${colour.green}${res.status} - ${ct||'No Content-Type specified'}.${colour.normal}`);
    let contents = await res.text();
    let json;
    if (contents.startsWith('<') || (ct && (ct.indexOf('/xml') > 0 || ct.indexOf('+xml') > 0))) {
      json = jgexml.xml2json(contents);
    }
    else {
      json = JSON5.parse(contents);
    }
    if (debug()) console.log(`${colour.yellow}${yaml.stringify(json)}${colour.normal}`);
    return truncate(yaml.stringify(json));
  }
  return `${res.status} - ${http.STATUS_CODES[res.status]}`;
};

const reset = async () => {
  console.log(`${colour.cyan}Resetting chat history.${colour.normal}`);
  history = "";
};

export const addToHistory = async (text) => {
  history += text;
  process.env.CHAT_HISTORY = history;
  return history;
}

const script = async (source) => {
  let functionOutput = '';
  scriptResult.chatResponse = '';
  let mod;
  try {
    mod = new vm.SourceTextModule(source,
      { identifier: 'temp', context: scriptResult });
  }
  catch (ex) {
    console.warn(`${colour.red}${ex.message} - ${source}${colour.normal}`);
    return `Parsing your script threw an error: ${ex.message}`;
  }

  async function linker(specifier, referencingModule) {
    return mod;
  }

  try {
    await mod.link(linker);
    console.log(`${colour.green}Evaluating script...${colour.normal}`);
    const ok = await mod.evaluate();
    if (ok) console.log(`${colour.green}Result: ${ok}${colour.normal}`);
    const ns = mod.namespace;
    if (ns.default && typeof ns.default === 'function') {
      functionOutput = ns.default();
    }
  }
  catch (ex) {
    console.warn(`${colour.red}${ex.message}${colour.normal}`);
    return `Running your script threw an error: ${ex.message}`;
  }
  if (scriptResult.chatResponse) {
    console.log(`${colour.grey}${scriptResult.chatResponse}${colour.normal}`);
    return scriptResult.chatResponse;
  }
  if (functionOutput) {
    console.log(`${colour.grey}${functionOutput}${colour.normal}`);
    return functionOutput;
  }
  console.log(`${colour.red}Script produced no results.${colour.normal}`);
  return 'No results.';
};

const savecode = async (input) => {
  const slug = `./BingChain-${uuidv4()}`;
  jsFiddle.saveFiddle({ title: slug, js: input, html: '', css: '' }, (err, body) => {
    if (err) console.warn(`${colour.red}${err.message}${colour.normal}`)
    else {
      fiddleSrc = body.replace('<h3>Framework <script> attribute</h3>','<h3>Framework Vue</h3>');
      fiddleSrc = fiddleSrc.replaceAll('<\\/', '</');
      fiddleSrc = fiddleSrc.replaceAll('\\n', '<b>');
      fiddleSrc = fiddleSrc.replaceAll(/\/js\/Groups.js.*\"/gi, 'lib/Groups.js"');
      fiddleSrc = fiddleSrc.replaceAll(/\/css\/dist-editor-dark.css.*\"/gi, 'css/dist-editor-dark.css"');
      fiddleSrc = fiddleSrc.replaceAll(/\/js\/_dist-editor.js.*\"/gi, 'js/_dist-editor.js"');
      open(`http://localhost:1337`);
    }
  });
}

const savecss = async (input) => {
  const slug = `./BingChain-${uuidv4()}`;
  jsFiddle.saveFiddle({ title: slug, js: '', html: '', css: input }, (err, body) => {
    if (err) console.warn(`${colour.red}${err.message}${colour.normal}`)
    else {
      fiddleSrc = body.replace('<h3>Framework <script> attribute</h3>','<h3>Framework Vue</h3>');
      fiddleSrc = fiddleSrc.replaceAll('<\\/', '</');
      fiddleSrc = fiddleSrc.replaceAll('\\n', '<b>');
      fiddleSrc = fiddleSrc.replaceAll(/\/js\/Groups.js.*\"/gi, 'lib/Groups.js"');
      fiddleSrc = fiddleSrc.replaceAll(/\/css\/dist-editor-dark.css.*\"/gi, 'css/dist-editor-dark.css"');
      fiddleSrc = fiddleSrc.replaceAll(/\/js\/_dist-editor.js.*\"/gi, 'js/_dist-editor.js"');
      open(`http://localhost:1337`);
    }
  });
}

const savetext = async (input) => {
  const slug = `./BingChain-${uuidv4()}`;
  if (!input.startsWith('<')) {
    input = `<html><div>${input}</div>`;
  }
  jsFiddle.saveFiddle({ title: slug, html: input, js: '', css: '' }, (err, body) => {
    if (err) console.warn(`${colour.red}${err.message}${colour.normal}`)
    else {
      fiddleSrc = body.replace('<h3>Framework <script> attribute</h3>','<h3>Framework Vue</h3>');
      fiddleSrc = fiddleSrc.replaceAll('<\\/', '</');
      fiddleSrc = fiddleSrc.replaceAll('\\n', '<b>');
      fiddleSrc = fiddleSrc.replaceAll(/\/js\/Groups.js.*\"/gi, 'lib/Groups.js"');
      fiddleSrc = fiddleSrc.replaceAll(/\/css\/dist-editor-dark.css.*\"/gi, 'css/dist-editor-dark.css"');
      fiddleSrc = fiddleSrc.replaceAll(/\/js\/_dist-editor.js.*\"/gi, 'js/_dist-editor.js"');
      open(`http://localhost:1337`);
    }
  });
}

function renderPdf(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: true })
  .then(function(textContent) {
    let lastY = '';
    let text = [];
    for (let item of textContent.items) {
      if (lastY != item.transform[5] || lastY){
        text.push('\n');
      }
      text.push(item.str);
      lastY = item.transform[5];
    }
    return text.join('');
  });
}

const readRemotePdf = async (url, metadata) => {
  let res = { ok: false, status: 418 };
  let result = 'No results.';
  try {
    res = await fetch(url, { redirect: 'follow' });
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
  }
  if (res.ok) {
    const pdfBuffer = Buffer.from(await res.arrayBuffer());
    process.stdout.write('...');
    try {
      const data = await pdf(pdfBuffer, { pagerender: renderPdf });
      result = data.text.split('  ').join(' ').split('\n\n\n').join('\n\n');
      console.log(`\n${colour.magenta}Rendered ${data.numpages} pages:\n${yaml.stringify(data.info)}${colour.normal}`);
      if (metadata) return yaml.stringify(data.info);
      if (debug()) console.log(`${colour.cyan}${result}${colour.normal}`);
      process.stdout.write('...');
      result = truncate(result);
      process.stdout.write('\n');
      return result;
    }
    catch (ex) {
      console.log(`${colour.red}${ex.message||ex}${colour.normal}`);
      return `Error ${ex.message} processing that PDF.`;
    }
  }
  else {
    return `${colour.red}${res.status} (${http.STATUS_CODES[res.status]}) reading that PDF.${colour.normal}`;
  }
};

const readRemoteDoc = async (url) => {
  let result = 'No results.';
  let res = { ok: false, status: 418 };
  try {
    res = await fetch(url, { redirect: 'follow' });
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
  }

  if (res.ok) {
    const docBuffer = Buffer.from(await res.arrayBuffer());
    process.stdout.write('...');
    try {
      const data = await mammoth.convertToHtml({ buffer: docBuffer });
      if (debug()) console.log(`${colour.cyan}${yaml.stringify(data.value)}${colour.normal}`);
      process.stdout.write('...');
      result = truncate(html2md.turndown(data.value));
      process.stdout.write('\n');
      return result;
    }
    catch (ex) {
      console.log(`${colour.red}${ex.message||ex}${colour.normal}`);
      return `Error ${ex.message} processing that .docx file.`;
    }
  }
  else {
    const msg = `${res.status} (${http.STATUS_CODES[res.status]}) reading that .docx file.`;
    if (!res.ok) return `${colour.red}${msg} reading that .docx file.${colour.normal}`;
  }
};

export const tools = {
  search: {
    description:
      "A search engine. Useful for when you need to answer questions about current events or retrieve in-depth answers. Input should be a search query.",
    execute: bingSearch,
    init: () => {
      if (!process.env.BING_API_KEY) {
        tools.disable.execute('search');
        process.stdout.write(`${colour.red}[2]${colour.magenta}`);
        return false;
      }
      return true;
    }
  },
  calculator: {
    description:
      "Useful for getting the result of a mathematical expression. The input to this tool should be a valid mathematical expression that could be executed by a simple scientific calculator.",
    execute: (input) => {
      let result = '';
      try {
        result = Parser.evaluate(input).toString();
      }
      catch (ex) {}
      return result;
    },
    init: nop
  },
  retrieve: {
    description:
      "A URL retrieval tool. Useful for returning the plain text of a web site from its URL. Javascript is not supported. Input should be in the form of an absolute URL. If using Wikipedia, always use https://simple.wikipedia.org in preference to https://en.wikipedia.org",
    execute: retrieveURL,
    init: nop
  },
  pagesource: {
    description:
      "A URL retrieval tool. Useful for returning the source HTML of a web site from its URL. Javascript is not supported. Input should be in the form of an absolute URL.",
    execute: retrieveHTML,
    init: nop
  },
  metadata: {
    description:
      "A tool used to retrieve metadata from a web page, including videos. Input should be in the form of a URL. The response will be in JSON format.",
    execute: retrieveMetadata,
    init: nop
  },
  image: {
    description: "A tool which allows you to retrieve and really display images from a web page in a text-based terminal. Prefer PNG and JPEG images. Input should be in the form of a URL.",
    execute: retrieveImage,
    init: nop
  },
  video: {
    description: "A tool which allows you to retrieve and really display videos from a web page in a text-based terminal. Input should be in the form of a URL.",
    execute: retrieveVideo,
    init: nop
  },
  install: {
    description:
      "A tool used to install API plugins. Input should be a bare domain name without a scheme/protocol or path.",
    execute: install,
    init: nop
  },
  apicall: {
    description: "A tool used to call a known API endpoint. Input should be in the form of an HTTP method in capital letters, followed by a colon (:) and the URL to call, made up of the relevant servers object entry and the selected operation's pathitem object key, having already replaced the templated path parameters. Headers should be provided after a # sign in the form of a JSON object of key/value pairs.",
    execute: apicall,
    init: nop
  },
  reset: {
    description: "A tool which simply resets the chat history to be blank. You must only call this when the chat history length exceeds half of your token limit.",
    execute: reset,
    init: nop
  },
  script: {
    description: "An ECMAScript/Javascript execution sandbox. Use this to evaluate Javascript programs. You do not need to use this tool just to have output displayed. The input should be in the form of a self-contained Javascript module (esm), which has an IIFE (Immediately Invoked Function Expression), or a default export function. To return text, assign it to the pre-existing global variable chatResponse. Do not redefine the chatResponse variable. You have access to global variables prompt and chatEnvironment.retrievedText Do not attempt to break out of the sandbox.",
    execute: script,
    init: () => {
      if (typeof vm.SourceTextModule === 'undefined') {
        tools.disable.execute('script');
        process.stdout.write(`${colour.red}[2]${colour.magenta}`);
        return false;
      }
      return true;
    }
  },
  savecode: {
    description: "A tool used to save a javascript snippet and open it in a browser. Input should be in the form of the javascript to save in plain text.",
    execute: savecode,
    init: nop
  },
  savehtml: {
    description: "A tool used to save a html text and open it in a browser. Input should be in the form of the html to save in plain text.",
    execute: savetext,
    init: nop
  },
  savecss: {
    description: "A tool used to save CSS/SCSS/SASS stylesheets and open them in a browser. Input should be in the form of the stylesheet to save in plain text.",
    execute: savecss,
    init: nop
  },
  savetext: {
    description: "A tool used to save a some text and open it in a browser. Input should be in the form of the text to save.",
    execute: savetext,
    init: nop
  },
  list: {
    description: "A tool used to list all the available enabled tools.",
    execute: async () => {
      let result = '';
      Object.keys(tools).sort().map((toolname) => {
        if (!blocked.has(toolname) || toolname === 'get') {
          result = result ? result + ', ' + toolname : toolname;
        }
        return result;
      });
      console.log(`${colour.magenta}${result}${colour.normal}`);
      return `Can you confirm that you have access to the following available tools: ${result}`;
    },
    init: nop
  },
  enable: {
    description: "A tool used to enable another tool.",
    execute: (toolname) => {
      blocked.delete(toolname);
      return `The ${toolname} tool has been enabled.`
    },
    init: nop
  },
  disable: {
    description: "A tool used to disable another tool. Use if a tool seems to be permanently broken.",
    execute: (toolname) => {
      blocked.set(toolname, true);
      return `The ${toolname} tool has been disabled.`
    },
    init: nop
  },
  set: {
    description: "A tool used to set environment variables. Input should be a string containing the key in uppercase, then an equals sign (=), then a value, with no quoting.",
    execute: (pair) => {
      const key = pair.split('=')[0].toUpperCase().trim();
      const value = pair.split('=')[1].trim();
      process.env[key] = value;
      return `The environment variable ${key} has been set to "${value}".`;
    },
    init: nop
  },
  get: {
    description: "A tool used to get environment variables. Input should be a string containing the key in uppercase. The result is the value of the given environment variable.",
    execute: async (key) => {
      key = key.split('=')[0].toUpperCase().trim();
      let value = process.env[key]||'';
      let allowed = false;
      if (key.startsWith('CHAT_')) allowed = true;
      if (key.endsWith('_TOOLS')) allowed = true;
      if (!allowed || blocked.has('get')) {
        if (!value && tools[key.toLowerCase()]) {
          value = blocked.has(key.toLowerCase()) ? 'disabled' : 'enabled';
        }
        return `The environment variable ${key} currently has the value "${value}".`;
      }
      return "The get tool is currently disabled for security reasons.";
    },
    init: () => {
      blocked.set('get',true);
      process.stdout.write(`${colour.green}[1]${colour.magenta}`);
      return true;
    }
  },
  readfile: {
    "description": "A tool used to read text files from the local filesystem we share. Input should be a relative or absolute file path. The result is the contents of the given file.",
    execute: (path) => {
      if (blocked.has('readfile')) {
        return "The readfile tool is currently disabled for security reasons.";
      }
      else {
        try {
          const text = fs.readFileSync(path, 'utf8');
          if (debug()) console.log(`${colour.cyan}${text}${colour.normal}`);
          return text;
        }
        catch (ex) {
          return ex.message;
        }
      }
    },
    init: () => {
      blocked.set('readfile',true);
      process.stdout.write(`${colour.green}[1]${colour.magenta}`);
      return true;
    }
  },
  retrievepdf: {
    description: "A tool used to read online PDFs by URL. The result is the contents of the given PDF in plain text form.",
    execute: async (url) => readRemotePdf(url, false),
    init: nop
  },
  retrievedoc: {
    description: "A tool used to read online Microsoft .docx files by URL. The result is the contents of the given .docx file in plain text form.",
    execute: readRemoteDoc,
    init: nop
  },
  metadatapdf: {
    description: "A tool used to read online PDFs by URL. The result is the metadata from the given PDF, including the number of pages and author, in plain text form.",
    execute: async (url) => readRemotePdf(url, true),
    init: nop
  },
  readdoc: {
    description: "A tool used to read .docx files only from the local filesystem we share. The result is the contents of the given .docx file in plain text form.",
    execute: async (path) => {
      let result = 'No results.';
      if (blocked.has('readdoc')) {
        result = "The readdoc tool is currently disabled for security reasons.";
      }
      else {
        try {
          const docBuffer = fs.readFileSync(path);
          process.stdout.write('...');
          const data = await mammoth.convertToHtml({ buffer: docBuffer });
          result = data.value;
          if (debug()) console.log(`${colour.cyan}${result}${colour.normal}`);
        }
        catch (ex) {
          console.log(`${colour.red}${ex.message||ex}${colour.normal}`);
          return result;
        }
      }
      process.stdout.write('...');
      result = truncate(result);
      process.stdout.write('\n');
      return result;
    },
    init: () => {
      blocked.set('readpdf',true);
      process.stdout.write(`${colour.green}[1]${colour.magenta}`);
      return true;
    }
  },
  readpdf: {
    description: "A tool used to read PDF files only from the local filesystem we share. The result is the contents of the given PDF in plain text form.",
    execute: async (path) => {
      let result = 'No results.';
      if (blocked.has('readpdf')) {
        result = "The readpdf tool is currently disabled for security reasons.";
      }
      else {
        try {
          const pdfBuffer = fs.readFileSync(path);
          process.stdout.write('...');
          const data = await pdf(pdfBuffer, { pagerender: renderPdf });
          result = data.text.split('  ').join(' ').split('\n\n\n').join('\n\n');
          console.log(`\n${colour.magenta}Rendered ${data.numpages} pages:\n${yaml.stringify(data.info)}${colour.normal}`);
          if (debug()) console.log(`${colour.cyan}${result}${colour.normal}`);
        }
        catch (ex) {
          console.log(`${colour.red}${ex.message||ex}${colour.normal}`);
          return result;
        }
      }
      process.stdout.write('...');
      result = truncate(result);
      process.stdout.write('\n');
      return result;
    },
    init: () => {
      blocked.set('readpdf',true);
      process.stdout.write(`${colour.green}[1]${colour.magenta}`);
      return true;
    }
  },
  graphql: {
    description: "A tool which should always be used to execute GraphQL queries. Input should be a JSON object in text form containing a url, and a query properties.",
    execute: async (value) => {
      console.log(value);
      value = yaml.parse(value);
      const url = value.url;
      const query = gql`${value.query}`;
      try {
        let response = await request({ url, document: query, fetch });
        response = yaml.stringify(response);
        if (debug) console.log(`${colour.cyan}${response}${colour.normal}`);
        return response;
      }
      catch (ex) {
        console.warn(`An error occurred: ${ex.message}`);
        return `An error occurred: ${ex.message}`;
      }
    },
    init: nop
  },
  findgraphql: {
    description: "A tool used to locate public GraphQL endpoints. The result is a table of public GraphQL endpoints in markdown format. The table contains the API identifier, the description, the GraphiQL URL from which the endpoint can be derived and a documentation / Github repository link.",
    execute: async () => {
      const results = await retrieveURL('https://raw.githubusercontent.com/graphql-kit/graphql-apis/master/README.md');
      if (debug()) console.log(results);
      return results;
    },
    init: nop
  }
}

export const scanEmbeddedImages = async (response) => {

  const images = new Map();
  const videos = new Map();

  const pngs = response.matchAll(/(https:\/\/.*\.png)/gi);
  for (const png of pngs) {
    if (png[0].indexOf('favicon') < 0) {
      images.set(png[0], png[0]);
    }
  }

  const jpegs = response.matchAll(/(https:\/\/.*\.jpe?g)/gi);
  for (const jpeg of jpegs) {
    images.set(jpeg[0], jpeg[0]);
  }

  const webps = response.matchAll(/(https:\/\/.*\.webp)/gi);
  for (const webp of webps) {
    images.set(webp[0], webp[0]);
  }

  const svgs = response.matchAll(/(https:\/\/.*\.svg)/gi);
  for (const svg of svgs) {
    images.set(svg[0], svg[0]);
  }

  const gifs = response.matchAll(/(https:\/\/.*\.gif)/gi);
  for (const gif of gifs) {
    images.set(gif[0], gif[0]);
  }

  const tiffs = response.matchAll(/(https:\/\/.*\.tiff)/gi);
  for (const tiff of tiffs) {
    images.set(tiff[0], tiff[0]);
  }

  const bmps = response.matchAll(/(https:\/\/.*\.bmp)/gi);
  for (const bmp of bmps) {
    images.set(bmp[0], bmp[0]);
  }

  const mp4s = response.matchAll(/(https:\/\/.*\.mp4)/gi);
  for (const mp4 of mp4s) {
    videos.set(mp4[0], mp4[0]);
  }

  for (const [key, value] of images) {
    try {
      await tools.image.execute(key);
    } catch (ex) {
      console.log(`${colour.red}${key} - ${ex.message}${colour.normal}`);
    }
  }

  for (const [key, value] of videos) {
    try {
      await tools.video.execute(key);
    } catch (ex) {
      console.log(`${colour.red}${key} - ${ex.message}${colour.normal}`);
    }
  }
}

await initialize(
  fs.readFileSync('./node_modules/svg2png-wasm/svg2png_wasm_bg.wasm')
);

