// tools that can be used to answer questions

import env from "dotenv";
env.config();

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import util from "node:util";

import yaml from 'yaml';
import metaFetcher from 'meta-fetcher';
import { svg2png, initialize } from 'svg2png-wasm';
import jsFiddle from 'jsfiddle';
import { v4 as uuidv4 } from 'uuid';
import open from 'open';
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';
import { isWithinTokenLimit } from 'gpt-tokenizer';
import { Image, Video, Gif } from 'termview';

import { colour } from "./colour.mjs";

const TOKEN_LIMIT = (parseInt(process.env.TOKEN_LIMIT,10)/2.0)||2048; // TODO
const scriptResult = { prompt: '', chatResponse: '', chatEnvironment: { retrievedText: '' } };
vm.createContext(scriptResult);

const html2md = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true });
const gfm = turndownPluginGfm.gfm
const tables = turndownPluginGfm.tables
const strikethrough = turndownPluginGfm.strikethrough

export let history = '';
let debug;
let RESPONSE_LIMIT;

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
};

export const setRetrievedText = (received) => {
  scriptResult.chatEnvironment.retrievedText = received;
  return received;
};

const truncate = (text) => {
  let count = 0;
  while (!isWithinTokenLimit(history + '\n' + text, TOKEN_LIMIT - RESPONSE_LIMIT, token_cache)) {
    count++;
    text = text.substring(0,Math.round(text.length*0.9));
  }
  if (count > 0) {
    output.write(`${colour.magenta}(Truncating)${colour.normal}`);
  }
  return text;
};

const nop = () => {};

// fallback tool in case initialisatio fails, or tool is disabled by human or AI
const stub = async (question) => {
  console.log(`${colour.red}This tool has been disabled.${colour.normal}`);
  return "No results, as this tool has been disabled. Do not use it again.";
};

// use Microsoft Bing to answer the question
const bingSearch = async (question) => {
  let hits = 0;
  return await fetch(
    `https://api.bing.microsoft.com/v7.0/search?q=${escape(question)}`, { headers: {"Ocp-Apim-Subscription-Key": process.env.BING_API_KEY } })
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
            results += `${value.name}:\n${value.snippet}\nFor further details, retrieve this URL: ${value.url}\n`;
          }
	      }
	      if (results.length < 10) {
	        results += 'None found.';
	      }
	      results += '\nEnd of results.'
	      if (debug) console.log(`${colour.yellow}${results}${colour.normal}`)
	      else console.log(`${colour.cyan}Found ${hits} search results.${colour.normal}`);
	      return results;
      });
};

const retrieveURL = async (url) => {
  if (url.startsWith('"')) {
    url = url.replace(/\\"/g, '');
  }
  if (url.startsWith("'")) {
    url = url.replace(/\\'/g, '');
  }
  let hoist;
  await fetch(url)
    .then((res) => {
      hoist = res;
      return res.text()
    })
    .then((txt) => {
      let text = truncate(html2md.turndown(txt));
      setRetrievedText(text);
      if (debug) console.log(`${colour.cyan}${text}${colour.normal}`);
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
    return setRetrievedText(result);
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
  }
  return 'No metadata found.'
};

const retrieveImage = async (url) => {
  let res = { ok: false, status: 500 };
  try {
    if (url.indexOf('.svg') >= 0) {
      res = await fetch(url, { headers: { "Accept": "image/svg+xml" } });
      const svg = await res.text();
      body = await svg2png(svg);
      url = './temp.png';
      fs.writeFileSync(url, body);
    }
    if (url.indexOf('.gif') >= 0) {
      const render = await Gif(url);
      console.log(render);
    }
    else {
      const render = await Image(url);
      console.log(render);
    }
  }
  catch (ex) {
    console.log(`${colour.red}${res.status} - ${http.STATUS_CODES[res.status]}: ${ex.message}${colour.normal}`);
    return `That URL returned status code ${res.status} - ${http.STATUS_CODES[res.status]}. Try again if you have more URLs.`;
  }
};

const retrieveVideo = async (url) => {
  let res = { ok: false, status: 500 };
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
    res = await fetch(pluginManifest);
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
  }
  if (res.ok) {
    plugin = await res.json();
    if (plugin.api.type === 'openapi') {
      res = { ok: false, status: 404 };
      try {
        res = await fetch(plugin.api.url);
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
    if (!stream) console.log(`${colour.red}${res.status} - ${http.STATUS_CODES[res.status]}${colour.normal}`);
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
    console.log(`${colour.green}${res.status} - ${res.headers['content-type']||'No Content-Type specified'}.${colour.normal}`);
    const json = await res.json(); // TODO XML APIs
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
    console.log(`${colour.grey}${functionResult}${colour.normal}`);
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

export const tools = {
  search: {
    description:
      "A search engine. Useful for when you need to answer questions about current events or retrieve in-depth answers. Input should be a search query.",
    execute: bingSearch,
    init: () => {
      if (!process.env.BING_API_KEY) {
        tools.search.execute = stub;
        console.log(`${colour.red}Bing API key not set - disabling the search tool.${colour.normal}`);
      }
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
    init: nop,
  },
  retrieve: {
    description:
      "A URL retrieval tool. Useful for returning the plain text of a web site from its URL. Javascript is not supported. Input should be in the form of an absolute URL. If using Wikipedia, always use https://simple.wikipedia.org in preference to https://en.wikipedia.org",
    execute: retrieveURL,
    init: nop,
  },
  metadata: {
    description:
      "A tool used to retrieve metadata from a web page, including videos. Input should be in the form of a URL. The response will be in JSON format.",
    execute: retrieveMetadata,
    init: nop,
  },
  image: {
    description: "A tool which allows you to retrieve and really display images from a web page in a text-based terminal. Prefer PNG and JPEG images. Input should be in the form of a URL.",
    execute: retrieveImage,
    init: nop,
  },
  video: {
    description: "A tool which allows you to retrieve and really display videos from a web page in a text-based terminal. Input should be in the form of a URL.",
    execute: retrieveVideo,
    init: nop,
  },
  install: {
    description:
      "A tool used to install API plugins. Input should be a bare domain name without a scheme/protocol or path.",
    execute: install,
    init: nop,
  },
  apicall: {
    description: "A tool used to call a known API endpoint. Input should be in the form of an HTTP method in capital letters, followed by a colon (:) and the URL to call, made up of the relevant servers object entry and the selected operation's pathitem object key, having already replaced the templated path parameters. Headers should be provided after a # sign in the form of a JSON object of key/value pairs.",
    execute: apicall,
    init: nop,
  },
  reset: {
    description: "A tool which simply resets the chat history to be blank. You must only call this when the chat history length exceeds half of your token limit.",
    execute: reset,
    init: nop,
  },
  script: {
    description: "An ECMAScript/Javascript execution sandbox. Use this to evaluate Javascript programs. You do not need to use this tool just to have output displayed. The input should be in the form of a self-contained Javascript module (esm), which has an IIFE (Immediately Invoked Function Expression), or a default export function. To return text, assign it to the pre-existing global variable chatResponse. Do not redefine the chatResponse variable. You have access to global variables prompt and chatEnvironment.retrievedText Do not attempt to break out of the sandbox.",
    execute: script,
    init: () => {
      if (typeof vm.SourceTextModule === 'undefined') {
        tools.script.execute = stub;
        console.log(`${colour.red}Experimental vm.modules not found - disabling the script tool.${colour.normal}`);
      }
    }
  },
  savecode: {
    description: "A tool used to save a javascript code and open it in a browser. Input should be in the form of the javscript to save in plain text.",
    execute: savecode,
    init: nop,
  },
  savehtml: {
    description: "A tool used to save a html text and open it in a browser. Input should be in the form of the html to save in plain text.",
    execute: savetext,
    init: nop,
  },
  savetext: {
    description: "A tool used to save a some text and open it in a browser. Input should be in the form of the text to save.",
    execute: savetext,
    init: nop,
  },
  list: {
    description: "A tool used to list all the available tools.",
    execute: async () => {
      let result = '';
      Object.keys(tools).sort().map((toolname) => {
        if (tools[toolname].execute !== stub) {
          result = result ? result + ', ' + toolname : toolname;
        }
      });
      console.log(`${colour.magenta}${result}${colour.normal}`);
      return `You have access to the following tools: ${result}`;
    },
    init: nop,
  },
  disable: {
    description: "A tool used to disable another tool. Use if a tool seems to be broken.",
    execute: (toolname) => {
      tools[toolname].execute = stub;
      return `Observe that the ${toolname} tool has been disabled.`
    },
    init: nop,
  },
  debug: {
    description: "A tool used to debug a tool. Use if a tool seems to be broken. Input should be a boolean.",
    execute: (value) => {
      debug = !!value;
      return `Debug mode has been ${debug ? 'enabled' : 'disabled'}.`
    },
    init: nop,
  }
};

export const scanEmbeddedImages = async (response) => {
  const pngs = response.matchAll(/(https:\/\/.*\.png)/gi);
  for (const png of pngs) {
    await tools.image.execute(png[0]);
  }

  const jpegs = response.matchAll(/(https:\/\/.*\.jpe?g)/gi);
  for (const jpeg of jpegs) {
    await tools.image.execute(jpeg[0]);
  }

  const webps = response.matchAll(/(https:\/\/.*\.webp)/gi);
  for (const webp of webps) {
    await tools.image.execute(webp[0]);
  }

  const svgs = response.matchAll(/(https:\/\/.*\.svg)/gi);
  for (const svg of svgs) {
    await tools.image.execute(svg[0]);
  }

  const gifs = response.matchAll(/(https:\/\/.*\.gif)/gi);
  for (const gif of gifs) {
    await tools.image.execute(gif[0]);
  }

  const mp4s = response.matchAll(/(https:\/\/.*\.mp4)/gi);
  for (const mp4 of mp4s) {
    await tools.video.execute(mp4[0]);
  }
}

await initialize(
  fs.readFileSync('./node_modules/svg2png-wasm/svg2png_wasm_bg.wasm'),
);

