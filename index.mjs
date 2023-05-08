import env from "dotenv";
env.config();

import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import yaml from "yaml";
import { Parser } from "expr-eval";
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';
import { isWithinTokenLimit } from 'gpt-tokenizer';

const html2md = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true });
const gfm = turndownPluginGfm.gfm
const tables = turndownPluginGfm.tables
const strikethrough = turndownPluginGfm.strikethrough

const TOKEN_LIMIT = (parseInt(process.env.TOKEN_LIMIT,10)/2.0)||2048; // TODO
const MODEL = process.env.MODEL || 'text-davinci-003';
const RESPONSE_LIMIT = 512;
const TEMPERATURE = parseFloat(process.env.temperature) || 0.7;
const token_cache = new Map();
const scriptResult = { chatResponse: '' };
vm.createContext(scriptResult);

let history = "";
let apiServer = "";

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
    { red: '', yellow: '', green: '', blue: '', normal: '' } :
    { red: '\x1b[31m', yellow: '\x1b[33;1m', green: '\x1b[32m', blue: '\x1b[34m', normal: '\x1b[0m' };

const truncate = (text) => {
  let count = 0;
  while (!isWithinTokenLimit(history + '\n' + text, TOKEN_LIMIT - RESPONSE_LIMIT, token_cache)) {
    count++;
    text = text.substring(0,Math.round(text.length*0.9));
  }
  if (count > 0) {
    output.write(`${colour.red}(Truncating)${colour.normal}`);
  }
  return text;
};

// fallback tool in case API key not specified
const nop = async (question) => {
  console.log(`${colour.red}Stubbing out an action call!${colour.normal}`);
  return 'No results.'
};

// use Microsoft Bing to answer the question
const bingSearch = async (question) =>
  await fetch(
    `https://api.bing.microsoft.com/v7.0/search?q=${escape(question)}`, { headers: {"Ocp-Apim-Subscription-Key": process.env.BING_API_KEY } })
    .then((res) => res.json())
    .then(
      (res) => {
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
  await fetch(url)
    .then((res) => res.text())
    .then((txt) => {
      let text = truncate(html2md.turndown(txt));
      return text;
    })
    .catch((ex) => '');
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
    console.log(`${colour.red}${res.status}${colour.normal}`);
  }
  return question;
};

const apicall = async (endpoint) => {
  const components = endpoint.split(':');
  const method = components.shift(1).toLowerCase();
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
  console.log('Using the',method,'method to call the',path,'endpoint');
  let res = { ok: false, status: 404 };
  try {
    res = await fetch(path,{ method, headers });
  }
  catch (ex) {}
  if (res.ok) {
    console.log(`${colour.green}${res.status} - ${res.headers['content-type']||'No Content-Type specified'}.${colour.normal}`);
    const json = await res.json(); // TODO XML APIs
    return truncate(yaml.stringify(json));
  }
  return `${res.status} - ${http.STATUS_CODES[res.status]}`;
};

const reset = async () => {
  console.log(`${colour.green}Resetting chat history.${colour.normal}`);
  history = "";
};


const script = async (source) => {
  let defaultOutput = '';
  if (source.indexOf("```") >= 0) {
    source = source.replace("```javascript", "```");
    source = source.replace("```js", "```");
    source = source.split("```")[1];
  }
  const mod = new vm.SourceTextModule(source,
      { identifier: 'temp', context: scriptResult });

  async function linker(specifier, referencingModule) {
    return mod;
  }

  await mod.link(linker);
  try {
    console.log(`${colour.green}Evaluating script...${colour.normal}`);
    await mod.evaluate();
    const ns = mod.namespace;
    if (ns.default && typeof ns.default === 'function') {
      defaultOutput = ns.default();
    }
  }
  catch (ex) {
    console.warn(`${colour.red}${ex.message}${colour.normal}`);
  }
  return scriptResult.chatResponse||defaultOutput||'No results.';
};

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
    description: "An ECMAScript/Javascript execution sandbox. Use this to evaluate Javascript programs. The input should be in the form of a self-contained Javascript module (esm), which has an IIFE (Immediately Invoked Function Expression), or a default export function. To return text, assign it to the pre-existing global variable chatResponse. Do not redefine the chatResponse variable. Do not attempt to break out of the sandbox.",
    execute: script,
  },
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
    top_p: 1,
    stream: false,
    stop: ["Observation:"],
  };
  if (MODEL.startsWith('text')) {
    body.prompt = prompt;
  }
  else {
    body.messages = [ { role: "system", content: "You are a helpful assistant who tries to answer all questions accurately and comprehensively." }, { role: "user", content: prompt }];
  }

  try {
    let res = await fetch(`https://api.openai.com/v1/${MODEL.startsWith('text') ? '' : 'chat/'}completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.log(`${colour.red}${res.status}${colour.normal}`);
    res = await res.json();
    if (typeof res === 'string') return res;
    if (!res.choices) {
      console.log(`${colour.blue}${yaml.stringify(res)}${colour.normal}`);
      return yaml.stringify(res)||'No response';
    }
    console.log(`${colour.red}${prompt}${colour.normal}`);
    if (res.choices && res.choices.length > 0 && res.choices[0].message) {
      console.log(`${colour.blue}${res.choices[0].message.content}${colour.normal}`);
      return res.choices[0].message.content;
    }
    console.log(`${colour.blue}${res.choices[0].text}${colour.normal}`);
    return res.choices[0].text;
  }
  catch (ex) {
    console.log(`${colour.red}${dummy} (${ex.message})${colour.normal}`);
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

    const action = response.match(/Action: (.*)/)?.[1].trim().toLowerCase();
    if (action && tools[action]) {
      // execute the action specified by the LLMs
      const actionInput = response.replace('Action Input: ', '').trim();
      const result = await tools[action].execute(actionInput);
      prompt += `Observation: ${result||'None'}\n`;
    } else {
      let answer = response.match(/Final Answer:(.*)/);
      if (answer && answer.length) {
        answer.shift(1);
        answer = answer.join('\n').trim();
      }
      if (answer) return answer;
      answer = response.match(/Observation:(.*)/)?.[1].trim();
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
  let question = await rl.question(`${colour.red}How can I help? >${colour.yellow} `);
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
  console.log(`${colour.green}${answer}${colour.normal}`);
  history += `Q:${question}\nA:${answer}\n`;
}
