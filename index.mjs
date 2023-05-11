import env from "dotenv";
env.config();

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import yaml from "yaml";
import { Parser } from "expr-eval";
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';
import { isWithinTokenLimit } from 'gpt-tokenizer';
import clipboard from 'clipboardy';
import metaFetcher from 'meta-fetcher';
import terminalImage from 'terminal-image';
import { svg2png, initialize } from 'svg2png-wasm';
import jsFiddle from 'jsfiddle';
import { v4 as uuidv4 } from 'uuid';
import Koa from 'koa';
import serve from 'koa-static';
import Router from 'koa-router';

import open from 'open';

const html2md = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true });
const gfm = turndownPluginGfm.gfm
const tables = turndownPluginGfm.tables
const strikethrough = turndownPluginGfm.strikethrough
const router = new Router();

const TOKEN_LIMIT = (parseInt(process.env.TOKEN_LIMIT,10)/2.0)||2048; // TODO
const MODEL = process.env.MODEL || 'text-davinci-003';
const RESPONSE_LIMIT = 512;
const TEMPERATURE = parseFloat(process.env.temperature) || 0.7;
const stream = true;
const token_cache = new Map();
const scriptResult = { chatResponse: '' };
vm.createContext(scriptResult);

await initialize(
  fs.readFileSync('./node_modules/svg2png-wasm/svg2png_wasm_bg.wasm'),
);

let completion = "";
let apiServer = "";
let fiddleSrc = "";

const app = new Koa();
app.use(serve('.'));
router.get('/', '/', (ctx) => {
  ctx.body = fiddleSrc;
});

app
  .use(router.routes())
  .use(router.allowedMethods());
app.listen(1337);

let history = "";
// Use the gfm, table and strikethrough plugins
html2md.use([gfm, tables, strikethrough]);
html2md.remove('aside');
html2md.remove('script');
html2md.remove('style');
html2md.remove('table'); // this may be controversial

const rl = readline.createInterface({ input, output });

const promptTemplate = fs.readFileSync("./prompt.txt", "utf8");
const mergeTemplate = fs.readFileSync("./merge.txt", "utf8");
const pluginTemplate = fs.readFileSync("./plugin.txt", "utf8");

const colour = (process.env.NODE_DISABLE_COLORS || !process.stdout.isTTY) ?
    { red: '', yellow: '', green: '', blue: '', normal: '', magenta: '', grey: '', inverse: '' } :
    { red: '\x1b[31m', yellow: '\x1b[33;1m', green: '\x1b[32m', blue: '\x1b[34m', magenta: '\x1b[35m', grey: '\x1b[90m', cyan: '\x1b[96m',
      inverse: '\x1b[7m', normal: '\x1b[27m\x1b[0m' };

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

/*This code defines an `async` function called `fetchStream` that uses `await` to simplify the code. The function returns the response body as text. You can call this function with the URL you want to fetch, and then log the result to the console.*/

async function fetchStream(url, options) {
  completion = "";
  const response = await fetch(url, options);
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    start(controller) {
      function push() {
        reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          let json;
          let hoist;
          if (value) try {
            const chunks = `${Buffer.from(value).toString()}`.split('\n');
            for (let chunk of chunks) {
              if (chunk) {
                hoist = chunk.trim();
                const json = yaml.parse((chunk||'{}').replace('data: {', '{')).choices?.[0];
                let text = (json && json.delta ? json.delta.content : json?.text) || '';
                process.stdout.write(text);
                completion += text;
              }
            }
          } catch (ex) {
            console.log(ex.message, hoist);
          }
          controller.enqueue(value);
          push();
        });
      }
      push();
    }
  });
  const newResponse = new Response(stream);
  const text = await newResponse.text();
  return text;
}

// fallback tool in case API key not specified
const nop = async (question) => {
  console.log(`${colour.red}Stubbing out an action call (no API key or access to vm.modules)!${colour.normal}`);
  return 'No results.'
};

// use Microsoft Bing to answer the question
const bingSearch = async (question) =>
  await fetch(
    `https://api.bing.microsoft.com/v7.0/search?q=${escape(question)}`, { headers: {"Ocp-Apim-Subscription-Key": process.env.BING_API_KEY } })
    .then((res) => {
      if (res.ok) return res.json()
      else {
        console.log(`${colour.red}${res.status} - ${http.STATUS_CODES[res.status]}${colour.normal}`);
        return {};
      }
    })
    .then((res) => {
        let results = 'Results:';
        // try to pull the answer from various components of the response
        if (res && res.webPages && res.webPages.value) {
          for (let value of res.webPages.value) {
            results + `${value.name}:\n${value.snippet}\nFor further reading, retrieve ${value.url}`;
          }
          return results;
	      }
	      return '';
      });

const retrieveURL = async (url) => {
  if (url.startsWith('"')) {
    url = url.replace(/\\"/g, '');
  }
  if (url.startsWith("'")) {
    url = url.replace(/\\'/g, '');
  }
  await fetch(url)
    .then((res) => res.text())
    .then((txt) => {
      let text = truncate(html2md.turndown(txt));
      console.log(`${colour.cyan}${text}${colour.normal}`);
      return text;
    })
    .catch((ex) => {
      console.log(`${colour.red}${ex.message}${colour.normal}`);
    });
  };

const retrieveMetadata = async (url) => {
  try {
    const res = await metaFetcher(url);
    return yaml.stringify(res);
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
  }
  return 'No metadata found.'
};

const retrieveImage = async (url) => {
  try {
    const res = await fetch(url, { headers: { "Accept": "image/*" } });
    if (res.ok) {
      let body;
      if (url.indexOf('.svg') >= 0) {
        const svg = await res.text();
        body = await svg2png(svg);
      }
      else {
        const ab = await res.arrayBuffer();
        if (ab) {
          body = Buffer.from(ab);
        }
      }
      console.log(await terminalImage.buffer(body));
      return 'Image successfully retrieved and displayed.'
    }
    else {
      console.log(`${colour.red}${res.status} - ${http.STATUS_CODES[res.status]}${colour.normal}`);
      return 'No image found.'
    }
  }
  catch (ex) {
    console.log(`${colour.red}${ex.message}${colour.normal}`);
  }
};

const install = async (domain) => {
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

// tools that can be used to answer questions
const tools = {
  search: {
    description:
      "A search engine. Useful for when you need to answer questions about current events or retrieve in-depth answers. Input should be a search query.",
    execute: bingSearch,
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
    }
  },
  retrieve: {
    description:
      "A URL retrieval tool. Useful for returning the plain text of a web site from its URL. Javascript is not supported. Input should be in the form of an absolute URL. If using Wikipedia, always use https://simple.wikipedia.org in preference to https://en.wikipedia.org",
    execute: retrieveURL,
  },
  metadata: {
    description:
      "A tool used to retrieve metadata from a web page, including videos. Input should be in the form of a URL. The response will be in JSON format.",
    execute: retrieveMetadata,
  },
  image: {
    description: "A tool which allows you to retrieve and really display images from a web page in a text-based terminal. Prefer PNG and JPEG images. Input should be in the form of a URL.",
    execute: retrieveImage,
  },
  install: {
    description:
      "A tool used to install API plugins. Input should be a bare domain name without a scheme/protocol or path.",
    execute: install,
  },
  apicall: {
    description: "A tool used to call a known API endpoint. Input should be in the form of an HTTP method in capital letters, followed by a colon (:) and the URL to call, made up of the relevant servers object entry and the selected operation's pathitem object key, having already replaced the templated path parameters. Headers should be provided after a # sign in the form of a JSON object of key/value pairs.",
   execute: apicall,
  },
  reset: {
    description: "A tool which simply resets the chat history to be blank. You must only call this when the chat history length exceeds half of your token limit.",
    execute: reset,
  },
  script: {
    description: "An ECMAScript/Javascript execution sandbox. Use this to evaluate Javascript programs. You do not need to use this tool just to have output displayed. The input should be in the form of a self-contained Javascript module (esm), which has an IIFE (Immediately Invoked Function Expression), or a default export function. To return text, assign it to the pre-existing global variable chatResponse. Do not redefine the chatResponse variable. Do not attempt to break out of the sandbox.",
    execute: script,
  },
  savecode: {
    description: "A tool used to save a javascript code and open it in a browser. Input should be in the form of the javscript to save in plain text.",
    execute: savecode,
  },
  savehtml: {
    description: "A tool used to save a html text and open it in a browser. Input should be in the form of the html to save in plain text.",
    execute: savetext,
  },
  savetext: {
    description: "A tool used to save a some text and open it in a browser. Input should be in the form of the text to save.",
    execute: savetext,
  }
};

if (!process.env.BING_API_KEY) tools.search.execute = nop;
if (typeof vm.SourceTextModule === 'undefined') tools.script.execute = nop;

// use GPT-3.5 to complete a given prompts
const completePrompt = async (prompt) => {
  let res = { ok: false, status: 500 };
  const dummy = "I took too long thinking about that.";
  const body = {
    model: MODEL,
    max_tokens: RESPONSE_LIMIT,
    temperature: TEMPERATURE,
    stream,
    user: 'BingChain',
    frequency_penalty: 0.5,
    n: 1,
    stop: ["Observation:", "Question:"],
  };
  if (MODEL.startsWith('text')) {
    body.prompt = prompt;
  }
  else {
    body.messages = [ { role: "system", content: "You are a helpful assistant who tries to answer all questions accurately and comprehensively." }, { role: "user", content: prompt }];
  }

  try {
    const url = `https://api.openai.com/v1/${MODEL.startsWith('text') ? '' : 'chat/'}completions`;
    process.stdout.write(colour.grey);
    let res = await fetchStream(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (completion.startsWith(' ')) {
      completion = completion.slice(1);
    }
    if (!completion.endsWith('\n\n')) {
      completion += '\n';
    }
    return completion;
  }
  catch (ex) {
    console.log(`${colour.red}(${ex.message})${colour.normal}`);
  }
  return dummy;
};

const answerQuestion = async (question) => {
  // construct the prompt, with our question and the tools that the chain can use
  let prompt = promptTemplate.replace("${question}", question).replace(
    "${tools}",
    Object.keys(tools)
      .map((toolname) => `${toolname}: ${tools[toolname].description}`)
      .join("\n")
  );

  // allow the LLM to iterate until it finds a final answer
  while (true) {
    const response = await completePrompt(prompt);

    // add this to the prompt
    prompt += response;

    const pngs = response.matchAll(/(https:\/\/.*\.png)/gi);
    for (const png of pngs) {
      try {
        const res = await fetch(png[0], { headers: { "Accept": "image/png" } });
        const ab = await res.arrayBuffer();
        const body = Buffer.from(ab);
        console.log(await terminalImage.buffer(body));
      }
      catch (ex) {
        //console.log(`${colour.red}${ex.message}${colour.normal}`);
      }
    }

    const jpegs = response.matchAll(/(https:\/\/.*\.jpe?g)/gi);
    for (const jpeg of jpegs) {
      try {
        const res = await fetch(jpeg[0], { headers: { "Accept": "image/jpeg" } });
        const ab = await res.arrayBuffer();
        const body = Buffer.from(ab);
        console.log(await terminalImage.buffer(body));
      }
      catch (ex) {
        //console.log(`${colour.red}${ex.message}${colour.normal}`);
      }
    }

    const svgs = response.matchAll(/(https:\/\/.*\.svg)/gi);
    for (const svg of svgs) {
      try {
        const res = await fetch(jpeg[0], { headers: { "Accept": "image/jpeg" } });
        const data = await res.text();
        const png = await svg2png(data);
        console.log(await terminalImage.buffer(png));
      }
      catch (ex) {
        //console.log(`${colour.red}${ex.message}${colour.normal}`);
      }
    }

    if (response.indexOf('Action:') >= 0) {
      const action = response.split('Action:').pop().split('\n')[0].toLowerCase().trim();
      if (action && tools[action]) {
        // execute the action specified by the LLMs
        let actionInput = response.split('Action Input:').pop().trim();
        if (actionInput.indexOf("```") >= 0) {
          actionInput = actionInput.replace("```javascript", "```");
          actionInput = actionInput.replace("```js", "```");
          actionInput = actionInput.split("```")[1];
        }
        else if (actionInput.indexOf(')()') >= 0) {
          actionInput = actionInput.split(')()')[0]+')()'.trim();
        }
        else if (actionInput.indexOf('```') >= 0) {
          actionInput = actionInput.split('```\n')[0].trim();
        }
        else {
          actionInput = actionInput.split('\n\n')[0].trim();
        }
        if (actionInput) {
          console.log(colour.blue+"\nCalling", action, "with", actionInput, colour.normal);
          const result = await tools[action].execute(actionInput);
          prompt += `Observation: ${result||'None'}\n`;
        }
      }
    } else {
      if (response.indexOf('Answer:') >= 0) {
        let answer = response.split('Answer:').pop();
        if (answer) return answer;
      }
      let answer = response.split('Observation:').pop().trim();
      return answer||'No answer'; // sometimes we don't get a "Final Answer"
    }
  }
};

// merge the chat history with a new question
const mergeHistory = async (question, history) => {
  const prompt = mergeTemplate
    .replace("${question}", question)
    .replace("${history}", history);
  return await completePrompt(prompt);
};

// main loop - answer the user's questions
while (true) {
  let question = await rl.question(`${colour.red}How can I help? >${colour.grey} `);
  if (question) clipboard.writeSync(question);
  let questionLC = question.trim().toLowerCase();
  if (questionLC.startsWith('install ') && questionLC.indexOf(' plugin') >= 0) {
    questionLC = questionLC.split('install ').join('');
    questionLC = questionLC.split('the ').join('');
    questionLC = questionLC.split(' plugin').join('');
    question = await install(questionLC.trim());
  }
  if (questionLC === 'reset') {
    reset();
  }
  if (history.length > 0) {
    question = await mergeHistory(question, history);
  }
  const answer = await answerQuestion(question);
  console.log(`${colour.green}\n${answer}${colour.normal}`);
  history += `Q:${question}\nA:${answer}\n`;
}
