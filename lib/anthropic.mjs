// use the given model to complete a given prompt
export const anthropicCompletion = async (prompt, fetchStream, agent) => {
  let res = { ok: false, status: 418 };
  const body = {
    prompt,
    model: process.env.MODEL,
    max_tokens_to_sample: process.env.RESPONSE_LIMIT,
    stream: true,
    temperature: parseFloat(process.env.TEMPERATURE),
    //top_p: TOP_P,
    //top_k: TOP_K,
    metadata: {
      user_id: 'BingChain',
    },
    stop_sequences: ["Observation:", "Question:"]
  };

  return await fetchStream(`https://api.anthropic.com/v1/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.ANTHROPIC_API_KEY
    },
    body: JSON.stringify(body),
    redirect: 'follow',
    agent
  });
};

