import fs from "fs";
import { Configuration, OpenAIApi } from "openai";

const apiKey = process.env.OPENAI_KEY;
const configuration = new Configuration({ apiKey });
const openai = new OpenAIApi(configuration);

export default openai;

const disabled = !apiKey;

export class Insight {
  summary: string[] = [];
  action_items: string[] = [];
  suggested_reply = "";
}

const promptPrefix = `
I will show you an email and you will answer as JSON with 3 properties; summary, action_items, suggested_reply.
\`summary\` and \`action_items\` should be arrays of strings each with a maximum length of 6.
\`suggested_reply\` should be string with fewer than 100 words and exclude header or footer.
Here's the email:
`;

export const getInsight = async (text: string) => {
  if (disabled || !text) return new Insight();
  const prompt = promptPrefix + text;
  const completion = await openai
    .createChatCompletion({
      model: "gpt-3.5-turbo-0301",
      messages: [{ role: "user", content: prompt }]
    })
    .catch((err) => {
      console.error(err.message);
      console.error(err.response.data.error);
    });

  const answer = completion?.data.choices[0]?.message?.content;

  try {
    return answer ? (JSON.parse(answer) as Insight) : new Insight();
  } catch (error) {
    console.error("Failed to get insight");
    console.error(error);
    if (answer) {
      const id = Date.now();
      if (!fs.existsSync("./error_ai")) fs.mkdirSync("./error_ai");
      const errorContent =
        `Prompt: [${prompt}]` + "\n\n" + `Answer: [${answer}]`;
      fs.writeFile(`./error_ai/${id}`, errorContent, (err) => {
        if (err) throw err;
      });
    }
    return new Insight();
  }
};
