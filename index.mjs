import env from "dotenv";
env.config();

import fs from "node:fs";
import https from "node:https";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import Koa from 'koa';
import serve from 'koa-static';
import Router from 'koa-router';
import yaml from 'yaml';
import JSON5 from 'json5'
import { highlight } from 'cli-highlight';
import chalk from 'chalk';

const shTheme = {
    keyword: chalk.white.bold,
    string: chalk.magenta.bold,
    number: chalk.green.bold,
    boolean: chalk.yellow,
    null: chalk.grey,
    operator: chalk.red.bold,
    punctuation: chalk.grey,
    comment: chalk.cyan.italic,
    regexp: chalk.yellow.bold.italic,
    addition: chalk.grey,
    deletion: chalk.red.strikethrough
};

import { tools, history, debug, addToHistory, setResponseLimit, scanEmbeddedImages,
  fiddleSrc, setPrompt, setRetrievedText, clean } from "./lib/tools.mjs";
import { colour } from "./lib/colour.mjs";

process.exitCode = 1;

const router = new Router();

const MODEL = process.env.MODEL || 'text-davinci-003';
const RESPONSE_LIMIT = parseInt(process.env.RESPONSE_LIMIT,10)||512;
const TEMPERATURE = parseFloat(process.env.TEMPERATURE) || 0.25;

setResponseLimit(RESPONSE_LIMIT);

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 120000, scheduling: 'lifo', family: 0, noDelay: false, zonread: { buffer: Buffer.alloc(RESPONSE_LIMIT * 2.75) } });

let completion = "";
let apiServer = "";
let booting = true;

const app = new Koa();
app.use(serve('.'));
router.get('/', '/', (ctx) => {
  ctx.body = fiddleSrc;
});
router.get('/', '/temp.png', (ctx) => {
  ctx.body = fs.readFileSync('./temp.png');
});

app
  .use(router.routes())
  .use(router.allowedMethods());
try {
  app.listen(parseInt(process.env.PORT,10)||1337);
}
catch (ex) {
  tools.disable.execute('savetext');
  tools.disable.execute('savehtml');
  tools.disable.execute('savecode');
  tools.disable.execute('savecss');
}

let localHistory = [];
try {
  localHistory = yaml.parse(fs.readFileSync('./history.yaml','utf8'));
}
catch (ex) {}
process.env.CHAT_QUERIES = localHistory.join(', ');

const rl = readline.createInterface({ input, output, history: localHistory, removeHistoryDuplicates: true });

const promptTemplate = fs.readFileSync("./prompt.txt", "utf8");
const mergeTemplate = fs.readFileSync("./merge.txt", "utf8");

const consume = async (value, chunkNo) => {
  const chunks = `${Buffer.from(value).toString()}`.split('\n');
  for (let chunk of chunks) {
    if (booting && chunkNo % 20 === 1) process.stdout.write('.')
    chunk = chunk.replaceAll('[DONE]', '["DONE"]');
    let json = {};
    try {
      if (parseInt(debug(),10) >= 3) console.log(`${colour.cyan}${chunk}${colour.normal}`);
      json = JSON5.parse(`{${chunk}}`)?.data?.choices?.[0];
      const text = clean((json && json.delta ? json.delta.content : json?.text) || '');
      if (!booting) process.stdout.write(text);
      completion += text;
    }
    catch (ex) {
      if (json.error) {
        return json.error;
      }
      return `(Stutter: ${ex.message})`;
    }
  }
}

async function fetchStream(url, options) {
  completion = "";
  let chunkNo = 0;
  let response = { ok: false, status: 418 }
  try {
    response = await fetch(url, options);
  }
  catch (ex) {
    console.warn(`${colour.red}${ex.message}${colour.normal}`);
  }
  if (response.status !== 200) {
    process.stdout.write(`${colour.red}`);
    let text = await response.text();
    try {
      let json = JSON5.parse(text);
      if (json.error && json.error.message) {
        completion = json.error.message;
        return text;
      }
    }
    catch (ex) {}
    completion = text;
    return text;
  }
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    start(controller) {
      function push() {
        reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          if (value) consume(value, ++chunkNo);
          controller.enqueue(value);
          push();
        });
      }
      push();
    },
    error (err) {
      console.log(`${colour.red}(${err.message})${colour.normal}`);
    },
    end () {
      if (debug()) console.log(`${colour.cyan}(End of stream)${colour.normal}`);
    }
  });
  const newResponse = new Response(stream);
  const text = await newResponse.text();
  return text;
}

// use the given model to complete a given prompts
const completePrompt = async (prompt) => {
  let res = { ok: false, status: 418 };
  const timeout  = "I took too long thinking about that.";
  const body = {
    model: MODEL,
    max_tokens: RESPONSE_LIMIT,
    temperature: TEMPERATURE,
    stream: true,
    user: 'BingChain',
    //frequency_penalty: 0.25,
    n: 1,
    stop: ["Observation:", "Question:"]
  };
  if (MODEL.startsWith('text')) {
    body.prompt = prompt;
  }
  else {
    body.messages = [ { role: "system", content: "You are a helpful assistant who tries to answer all questions accurately and comprehensively." }, { role: "user", content: prompt }];
  }

  const url = `https://api.openai.com/v1/${MODEL.startsWith('text') ? '' : 'chat/'}completions`;
  process.stdout.write(colour.grey);
  res = await fetchStream(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.OPENAI_API_KEY
    },
    redirect: 'follow',
    body: JSON.stringify(body),
    agent
  });
  if (!completion.endsWith('\n\n')) {
    completion += '\n';
  }
  return completion;
};

const answerQuestion = async (question) => {
  // construct the prompt, with our question and the tools that the chain can use
  let prompt = promptTemplate.replace("${question}", question).replace(
    "${tools}",
    Object.keys(tools)
      .map((toolname) => `${toolname}: ${tools[toolname].description}`)
      .join("\n"))
    .replace("${toolList}", Object.keys(tools).join(", "))
    .replace("${user}", process.env.USER)
    .replace('${language}',process.env.LANG);
  process.env.PROMPT = prompt;
  process.env.CHAT_PROMPT = prompt;

  if (process.env.PROMPT_OVERRIDE) {
    prompt = process.env.PROMPT_OVERRIDE.replaceAll("${question}", question);
  }

  // allow the LLM to iterate until it finds a final answer
  while (true) {
    const response = await completePrompt(prompt);

    // add this to the prompt
    prompt += response;

    // display any embedded image URLs
    scanEmbeddedImages(response);

    if (response.indexOf('Action:') >= 0) {
      const action = response.split('Action:').pop().split('\n')[0].toLowerCase().trim();
      if (action && tools[action]) {
        // execute the action specified by the LLM
        let actionInput = response.split('Action Input:').pop().trim();
        if (actionInput.indexOf("```") >= 0) {
          actionInput = actionInput.replace(/```.+/gi, "```");
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
        if (actionInput && !actionInput.startsWith('[')) {
          setPrompt(prompt);
          if (process.env.SYNTAX) {
            actionInput = highlight(actionInput, { language: 'javascript', theme: shTheme, ignoreIllegals: true });
          }
          if (!booting) console.log(`${colour.cyan}\nCalling '${action}' with "${actionInput}"${colour.normal}`);
          const result = await tools[action].execute(clean(actionInput));
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

process.stdout.write(`${colour.cyan}Initialising built-in tools: `);
let allOk = true;
let first = true;
Object.keys(tools).sort().map((toolname) => {
  if (!first) {
    process.stdout.write(', ');
  }
  process.stdout.write(`${colour.magenta}${toolname}`);
  const result = (async () => await tools[toolname].init())();
  first = false;
  if (!result) allOk = false;
});
console.log(colour.normal);

if (localHistory.length && process.env.SEED_QUERIES) {
  booting = true;
  const query = `Can you get the CHAT_QUERIES so you can remember the previous questions I have asked? You do not need to list them.`;
  process.stdout.write(`${colour.cyan}Please wait, bootstrapping conversation${colour.magenta}`);
  const response = await answerQuestion(query);
}

rl.on('history',(history) => {
  fs.writeFileSync('./history.yaml',yaml.stringify(history),'utf8');
});

if (!allOk) {
  console.log(`\n${colour.cyan}[2] some tools were disabled because of missing API keys or node.js features.${colour.normal}`);
}

// main loop - answer the user's questions
while (true) {
  booting = false;
  debugger;
  let question = await rl.question(`${colour.red}How can I help? >${colour.grey} `);
  let questionLC = question.trim().toLowerCase();
  questionLC = question.split('please').join('').trim();
  let verb = questionLC.split(' ')[0].toLowerCase().trim();
  if (tools[verb] || (verb.startsWith(':') && tools[verb.replace(':','')])) {
    verb = verb.replace(':','');
    console.log(`${colour.magenta}${await tools[verb].execute(clean(questionLC.slice(verb.length+1)))}${colour.normal}`);
    question = '';
  }
  else if (verb.startsWith(':')) {
    if (question.startsWith(':q') || question.startsWith(':wq')) {
      console.log(`\nSaving history and exiting with 0.`);
      process.exit(0);
    }
    else if (question.startsWith(':syntax')) {
      const value = question.split(' ')[1].trim().toLowerCase();
      process.env.SYNTAX = (value === 'on' || value === 'true' || value === '1' || value === 'yes') ? 1 : 0;
      question = '';
    }
    else if (question.startsWith(':help')) {
      question = "How should a novice user get the best out of this chat experience?";
    }
    else if (question === (':set')) {
      console.log(yaml.stringify(process.env));
      question = '';
    }
    else if (question.startsWith(':set ')) {
      question = question.replace('=',' ');
      question = question.split('  ').join(' ');
      let words = question.split(' ');
      let key = words[1]
      key = key.toUpperCase();
      words.splice(0, 2);
      const value = words.join(' ');
      process.env[key] = value;
      question = '';
    }
  }
  let answer = '';
  if (question) answer = await answerQuestion(question);
  while (process.env.SYNTAX === '1' && answer.indexOf('```\n') >= 0) {
    const sections = answer.split('```');
    const preamble = sections[0];
    const language = sections[1].split('\n')[0].trim();
    const code = sections[1].replace(language + '\n', '');
    const tail = sections[2];
    answer = preamble + highlight(code, { language, theme: shTheme, ignoreIllegals: true }) + tail;
  }
  if (question || answer) {
    console.log(`\n${colour.green}${answer.trimStart()}${colour.normal}`);
    addToHistory(`Q:${question}\nA:${answer}\n`);
  }
}

