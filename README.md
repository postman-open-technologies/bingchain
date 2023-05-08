# 🕵️🔗 BingChain

This is an evolution of [langchain-mini](https://github.com/ColinEberhardt/langchain-mini), a very simple re-implementation of [LangChain](https://github.com/hwchase17/langchain), in ~350 lines of code. In essence, it is an LLM (GPT-3.5) powered chat application that is able to use tools (Microsoft Bing search, URL retrieval, API plugin installation, API calls, a Javascript sandbox, and a scientific calculator) in order to hold conversations and answer questions.

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

This is not intended to be a replacement for LangChain, which has many composable elements, instead it was built to demonstrate the power of assembling a set of tools (such as API calling and Javascript execution). If you're interested in how LangChain, and similar tools work, this is a very good starting point.

## Running / developing

Install dependencies, and run (with node >= v18):

~~~
% npm install
~~~

You'll need to have both an OpenAI and Bing API keys. These can be supplied to the application via a `.env` file:

~~~
OPENAI_API_KEY="..."
BING_API_KEY="..."
MODEL=gpt-4
TOKEN_LIMIT=32768
~~~

Set the token limit to the advertised limit of the model you are using, so 32768 for `gpt-4`, 4096 for `text-davinci-003` and 2048 for `text-curie-001`.

The clever part is the initial prompt, which is held in [`prompt.txt`](https://raw.githubusercontent.com/postman-open-technologies/bingchain/main/prompt.txt).

You can now run the chain:

~~~
% node index.mjs
How can I help? > what was the name of the first man on the moon?
Neil Armstrong
~~~

**Note**: to enable the Javascript sandbox, you must pass the option `--experimental-vm-modules` to Node.js.

## Future work planned

* Ideas gratefully received.
