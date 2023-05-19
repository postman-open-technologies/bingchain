// use the given model to complete a given prompt
export const openaiCompletion = async (prompt, fetchStream, agent) => {
  let res = { ok: false, status: 418 };
  const body = {
    model: process.env.MODEL,
    max_tokens: parseInt(process.env.RESPONSE_LIMIT, 10),
    temperature: parseFloat(process.env.TEMPERATURE),
    stream: true,
    user: 'BingChain',
    //frequency_penalty: 0.25,
    n: 1,
    stop: ["Observation:", "Question:"]
  };
  if (process.env.MODEL.startsWith('text')) {
    body.prompt = prompt;
  }
  else {
    body.messages = [ { role: "system", content: "You are a helpful assistant who tries to answer all questions accurately and comprehensively." }, { role: "user", content: prompt } ];
  }

  const url = `https://api.openai.com/v1/${process.env.MODEL.startsWith('text') ? '' : 'chat/'}completions`;
  return await fetchStream(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.OPENAI_API_KEY
    },
    body: JSON.stringify(body),
    redirect: 'follow',
    agent
  });
};

