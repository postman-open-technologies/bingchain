import env from "dotenv";
env.config();

import fs from "node:fs";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import yaml from "yaml";
import { Parser } from "expr-eval";
import clipboard from 'clipboardy';
import Koa from 'koa';
import serve from 'koa-static';
import Router from 'koa-router';

import { tools, history, addToHistory, setResponseLimit, scanEmbeddedImages, fiddleSrc,
  setPrompt, setRetrievedText } from "./lib/tools.mjs";
import { colour } from "./lib/colour.mjs";

const router = new Router();

const MODEL = process.env.MODEL || 'text-davinci-003';
const RESPONSE_LIMIT = parseInt(process.env.RESPONSE_LIMIT,10)||512;
const TEMPERATURE = parseFloat(process.env.temperature) || 0.25;

setResponseLimit(RESPONSE_LIMIT);

let completion = "";
let apiServer = "";

const app = new Koa();
app.use(serve('.'));
router.get('/', '/', (ctx) => {
  ctx.body = fiddleSrc;
});

app
  .use(router.routes())
  .use(router.allowedMethods());
app.listen(1337);

const rl = readline.createInterface({ input, output });

const promptTemplate = fs.readFileSync("./prompt.txt", "utf8");
const mergeTemplate = fs.readFileSync("./merge.txt", "utf8");
const pluginTemplate = fs.readFileSync("./plugin.txt", "utf8");

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
  return timeout;
};

const answerQuestion = async (question) => {
  // construct the prompt, with our question and the tools that the chain can use
  let prompt = promptTemplate.replace("${question}", question).replace(
    "${tools}",
    Object.keys(tools)
      .map((toolname) => `${toolname}: ${tools[toolname].description}`)
      .join("\n")
  ).replace("${toolList}", Object.keys(tools).join(", "));

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
        if (actionInput) {
          setPrompt(prompt);
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

Object.keys(tools).map((toolname) => {
  console.log(`${colour.blue}Initialising ${toolname}...${colour.normal}`);
  tools[toolname].init();
});

// main loop - answer the user's questions
while (true) {
  let question = await rl.question(`${colour.red}How can I help? >${colour.grey} `);
  if (question) clipboard.writeSync(question);
  let questionLC = question.trim().toLowerCase();
  questionLC = question.split('please').join('').trim();
  const verb = questionLC.split(' ')[0];
  if (tools[verb]) {
    question = await tools[verb].execute(questionLC.slice(verb.length+1));
  }
  if (history.length > 0) {
    question = await mergeHistory(question, history);
  }
  const answer = await answerQuestion(question);
  console.log(`\n${colour.green}${answer.trimStart()}${colour.normal}`);
  addToHistory(`Q:${question}\nA:${answer}\n`);
}

