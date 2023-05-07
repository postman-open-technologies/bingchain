import env from "dotenv";
env.config();

import fs from "node:fs";
import yaml from "yaml";
import { Parser } from "expr-eval";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';
import { isWithinTokenLimit } from 'gpt-tokenizer';

const html2md = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true });
const gfm = turndownPluginGfm.gfm
const tables = turndownPluginGfm.tables
const strikethrough = turndownPluginGfm.strikethrough

const TOKEN_LIMIT = 3072;
const RESPONSE_LIMIT = 512;
const TEMPERATURE = parseFloat(process.env.temperature) || 0.7;
const token_cache = new Map();

// Use the gfm, table and strikethrough plugins
html2md.use([gfm, tables, strikethrough]);
html2md.remove('style');
html2md.remove('script');

const rl = readline.createInterface({ input, output });

const promptTemplate = fs.readFileSync("./prompt.txt", "utf8");
const mergeTemplate = fs.readFileSync("./merge.txt", "utf8");
const pluginTemplate = fs.readFileSync("./plugin.txt", "utf8");

const colour = (process.env.NODE_DISABLE_COLORS || !process.stdout.isTTY) ?
    { red: '', yellow: '', green: '', blue: '', normal: '' } :
    { red: '\x1b[31m', yellow: '\x1b[33;1m', green: '\x1b[32m', blue: '\x1b[34m', normal: '\x1b[0m' };

const truncate = (text) => {
  while (!isWithinTokenLimit(text, TOKEN_LIMIT - RESPONSE_LIMIT, token_cache)) {
    text = text.substring(0,Math.round(text.length*0.9));
  }
  return text;
};

// fallback tool in case API key not specified
const nop = async (question) => '';

// use Microsoft Bing to answer the question
const bingSearch = async (question) =>
  await fetch(
    `https://api.bing.microsoft.com/v7.0/search?q=${escape(question)}`, { headers: {"Ocp-Apim-Subscription-Key": process.env.BING_API_KEY } })
    .then((res) => res.json())
    .then(
      (res) => {
        // try to pull the answer from various components of the response
        if (res && res.webPages && res.webPages.value) {
          return res.webPages.value[0].snippet
	}
	return '';
      }
    );

const retrieveURL = async (url) =>
  await fetch(url)
    .then((res) => res.text())
    .then((txt) => {
      let text = truncate(html2md.turndown(txt));
      return text;
    })
    .catch((ex) => '');

const install = async (domain) => {
  const pluginManifest = `https://${domain}/.well-known/ai-plugin.json`;
  let res = { ok: false, status: 404 };
  let plugin;
  let question = '';
  try {
    res = await fetch(pluginManifest);
  }
  catch (ex) {}
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
          const openApiYaml = yaml.stringify(yaml.parse(apiDef));
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
  return question;
};

const apicall = async (endpoint) => {
  const components = endpoint.split(':');
  const method = components.shift(1).toLowerCase();
  const path = components.join(':').trim();
  console.log('Using the',method,'method to call the',path,'endpoint');
  let res = { ok: false, status: 404 };
  try {
    res = await fetch(path,{ method });
  }
  catch (ex) {}
  if (res.ok) {
    const json = await res.json(); // TODO XML APIs
    return truncate(yaml.stringify(json));
  }
  return '404 - not found';
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
      "Useful for getting the result of a math expression. The input to this tool should be a valid mathematical expression that could be executed by a simple calculator.",
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
      "A URL retrieval tool. Useful for returning the plain text of a web URL. Javascript is not supported. Input should be an absolute URL.",
    execute: retrieveURL,
  },
  install: {
    description:
      "A tool used to install API plugins. Input should be a bare domain name without a scheme/protocol or path.",
    execute: install,
  },
  apicall: {
    description: "A tool used to call a known API endpoint. Input should be in the form of an HTTP method in capital letters, followed by a colon (:) and the URL to call, made up of the relevant servers object entry and the selected operation's pathitem object key, having already replaced the templated path parameters.",
   execute: apicall,
  }
};
if (!process.env.BING_API_KEY) tools.search.execute = nop;

// use GPT-3.5 to complete a given prompts
const completePrompt = async (prompt) =>
  await fetch("https://api.openai.com/v1/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: "text-davinci-003",
      prompt,
      max_tokens: RESPONSE_LIMIT,
      temperature: TEMPERATURE,
      stream: false,
      stop: ["Observation:"],
    }),
  })
    .then((res) => res.json())
    .then((res) => {
      if (typeof res === 'string') return res;
      if (!res.choices) return yaml.stringify(res);
      return res.choices[0].text;
    })
    .then((res) => {
      console.log(`${colour.red}${prompt}${colour.normal}`);
      console.log(`${colour.blue}${res}${colour.normal}`);
      return res;
    });

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
      const actionInput = response.match(/Action Input: "?(.*)"?/)?.[1];
      const result = await tools[action].execute(actionInput);
      prompt += `Observation: ${result}\n`;
    } else {
      let answer = response.match(/Final Answer:(.*)/)?.[1].trim();
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
let history = "";
while (true) {
  let question = await rl.question(`${colour.red}How can I help? >${colour.yellow} `);
  let questionLC = question.trim().toLowerCase();
  if (questionLC.startsWith('install ') && questionLC.indexOf(' plugin') >= 0) {
    questionLC = questionLC.split('install ').join('');
    questionLC = questionLC.split('the ').join('');
    questionLC = questionLC.split(' plugin').join('');
    question = await install(questionLC.trim());
  }
  if (history.length > 0) {
    question = await mergeHistory(question, history);
  }
  const answer = await answerQuestion(question);
  console.log(`${colour.green}${answer}${colour.normal}`);
  history += `Q:${question}\nA:${answer}\n`;
}
