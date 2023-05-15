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

import { tools, history, debug, addToHistory, setResponseLimit, scanEmbeddedImages,
  fiddleSrc, setPrompt, setRetrievedText } from "./lib/tools.mjs";
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

async function fetchStream(url, options) {
  completion = "";
  let streamNo = 0;
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
          if (value) {
            const chunks = `${Buffer.from(value).toString()}`.split('\n');
            for (let chunk of chunks) {
              streamNo++;
              if (booting && streamNo % 20 === 1) process.stdout.write('.')
              chunk = chunk.replaceAll('[DONE]', '["DONE"]');
              hoist = chunk;
              let json = {};
              try {
                if (parseInt(debug(),10) >= 3) console.log(`${colour.cyan}${chunk}${colour.normal}`);
                json = JSON5.parse(`{${chunk}}`)?.data?.choices?.[0];
                let text = (json && json.delta ? json.delta.content : json?.text) || '';
                if (!booting) process.stdout.write(text);
                completion += text;
              }
              catch (ex) {
                if (json.error) {
                  const result = json.error;
                  return result;
                }
                const result = `(Stutter: ${ex.message})`;
                return result;
              }
            }
          }
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
  let res = { ok: false, status: 500 };
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

  try {
    const url = `https://api.openai.com/v1/${MODEL.startsWith('text') ? '' : 'chat/'}completions`;
    process.stdout.write(colour.grey);
    let res = await fetchStream(url, {
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
  }
  catch (ex) {
    console.log(`${colour.red}(${ex.message})${colour.normal}`);
  }
  return timeout;
};

const answerQuestion = async (question) => {
  // construct the prompt, with our question and the tools that the chain can use
  let prompt = promptTemplate.replace("${question}", question).replace(
    "${tools}",
    Object.keys(tools)
      .map((toolname) => `${toolname}: ${tools[toolname].description}`)
      .join("\n")
  ).replace("${toolList}", Object.keys(tools).join(", ")).replace('${language}',process.env.LANGUAGE);
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
        // execute the action specified by the LLMs
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
          if (!booting) console.log(`${colour.cyan}\nCalling '${action}' with "${actionInput}"${colour.normal}`);
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

booting = true;
const query = `Can you get the CHAT_QUERIES so you can remember the previous questions I have asked? You do not need to list them.`;
process.stdout.write(`${colour.cyan}Please wait, bootstrapping conversation${colour.magenta}`);
const response = await answerQuestion(query);
//console.log(`\n${colour.green}${response.trimStart()}${colour.normal}`);
//addToHistory(`Q:${query}\nA:${response}\n`);

rl.on('history',(history) => {
  fs.writeFileSync('./history.yaml',yaml.stringify(history),'utf8');
});

if (!allOk) {
  console.log(`\n${colour.cyan}[2] some tools were disabled because of missing API keys or node.js features.${colour.normal}`);
}

// main loop - answer the user's questions
while (true) {
  booting = false;
  let question = await rl.question(`${colour.red}How can I help? >${colour.grey} `);
  let questionLC = question.trim().toLowerCase();
  questionLC = question.split('please').join('').trim();
  const verb = questionLC.split(' ')[0].toLowerCase().trim();
  if (tools[verb]) {
    question = await tools[verb].execute(questionLC.slice(verb.length+1));
    console.log(`${colour.magenta}${question}${colour.normal}`);
  }
  if (verb.startsWith(':')) {
    if (question.startsWith(':q') || question.startsWith(':wq')) {
      console.log(`\nSaving history and exiting with 0.`);
      process.exit(0);
    }
    if (question.startsWith(':syntax')) {
      question = "Please include ANSI escape sequences in code blocks, use appropriate syntax-highlighting for the language being output.";
    }
    if (question.startsWith(':help')) {
      question = "How should a novice user get the best out of this chat experience?";
    }
    if (question === (':set')) {
      console.log(yaml.stringify(process.env));
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
      question = `Observe that the ${key} environment variable has been set to "${value}".`;
    }
  }
  const answer = await answerQuestion(question);
  console.log(`\n${colour.green}${answer.trimStart()}${colour.normal}`);
  addToHistory(`Q:${question}\nA:${answer}\n`);
}

