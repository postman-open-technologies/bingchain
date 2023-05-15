# 🕵️🔗 BingChain

This is an evolution of [langchain-mini](https://github.com/ColinEberhardt/langchain-mini), a very simple re-implementation of [LangChain](https://github.com/hwchase17/langchain), in ~300 lines of core code. In essence, it is a multi-model LLM-powered chat application that is able to use tools (Microsoft **Bing** search, URL retrieval, API plugin installation, API calls, a Javascript sandbox, JsFiddle creation, image and video preview, and a scientific calculator, as well as meta-tools such as `list`, `disable`, `reset` and `debug`) in order to build a **chain** of thought to hold conversations and answer questions.

Here's an example:

~~~
Q: What is the world record for solving a rubiks cube?
The world record for solving a Rubik's Cube is 4.69 seconds, held by Yiheng Wang (China).
Q: Can a robot solve it faster?
The fastest time a robot has solved a Rubik's Cube is 0.637 seconds.
Q: Who made this robot?
Infineon created the robot that solved a Rubik's Cube in 0.637 seconds.
Q: What time would an average human expect for solving?
It takes the average person about three hours to solve a Rubik's cube for the first time.
~~~

This is not intended to be a replacement for LangChain, which has many alternative and composable building blocks, instead it was built to demonstrate the power of assembling a set of tools (such as API calling and Javascript execution). If you're interested in how LangChain, and similar tools work, this is a very good starting point.

## Running / developing

Install dependencies, and run (with node >= v18):

~~~
% npm install
~~~

To display videos in the terminal, you will need to install `ffmpeg`.

You'll need to have an OpenAI API key, and optionally a Bing Search API key. These can be supplied to the application via a `.env` file:

~~~
OPENAI_API_KEY="..."
BING_API_KEY="..."
MODEL=gpt-4
TOKEN_LIMIT=32768
TEMPERATURE=0.25
RESPONSE_LIMIT=512
MAX_REDIRECTS=10
PORT=1337
LANGUAGE=en_GB:en
DEBUG=""
PROMPT_OVERRIDE=Simply answer me this: \"${question}\"
~~~

Set the token limit to the advertised limit of the model you are using, so 32768 for `gpt-4`, 4096 for `text-davinci-003` and 2048 for `text-curie-001`.

The clever part is the default initial prompt, which is held in [`prompt.txt`](https://raw.githubusercontent.com/postman-open-technologies/bingchain/main/prompt.txt), unless overridden by the `PROMPT_OVERRIDE` environment variable.

Example prompts and responses to show how the various built-in tools work can be found in the [`examples`](https://github.com/postman-open-technologies/bingchain/tree/main/examples) directory. The tools themselves are defined in [`lib/tools.mjs`](https://github.com/postman-open-technologies/bingchain/tree/main/lib/tools.mjs), including the `description` properties which act as further prompts to the LLM to suggest when and how the tools should be used.

There are a few Javascript and CSS files scattered about from [jsfiddle.net](https://jsfiddle.net/) to make the `savetext`, `savehtml` and `savecode` tools work locally.

**Note**: to enable the Javascript sandbox, you must pass the option `--experimental-vm-modules` to Node.js. The included `go.sh` script sets the Node.js recommended options.

## Example dialogue

You can now run the chain:

```repl
% ./go.sh
How can I help? > what was the name of the first woman in space?
```

* I need to search for the name of the first woman in space.
* *Action*: `search`
* *Action Input*: `first woman in space name`

Calling `search` with `first woman in space name`

1. **Valentina Tereshkova - First Woman in Space - Biography**
2. **Valentina Tereshkova: First Woman in Space | Space**
3. **The First Woman in Space: Valentina Tereshkova - ThoughtCo**

* *Thought*: I now know the final answer.
* *Final Answer*: The name of the first woman in space is Valentina Tereshkova.
* **The name of the first woman in space is Valentina Tereshkova.**

### Exiting the chain / vi mode

* You can use `vi`/`vim`-like commands to exit, such as `:q` or you can Ctrl-C twice to exit.
* You can use `:set` to query all environment variables or `:set [variable]=[value]` to temporarily amend the current environment.

## Authors

* [Mike Ralphson](https://github.com/MikeRalphson)
* [Gbadeyboh Bello](https://github.com/Gbahdeyboh)
* [Colin Eberhardt](https://github.com/ColinEberhardt)

## Future work planned

* Ideas and PRs gratefully received.
