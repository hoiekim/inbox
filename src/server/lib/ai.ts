import fs from "fs";
import { Configuration, OpenAIApi } from "openai";
import { MailType } from "server";

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
\`summary\` should be an array of strings with a maximum length of 6.
\`action_items\` should be an array of strings with a maximum length of 3.
\`suggested_reply\` should be string with fewer than 100 words and exclude header or footer.
Here's the email:
`;

export const getInsight = async (mail: MailType & { text: string }) => {
  if (disabled) return new Insight();

  const { subject, from, to, text } = mail;
  const promptBody = JSON.stringify({ subject, from, to, text });

  const prompt = promptPrefix + promptBody;
  const completion = await openai
    .createChatCompletion({
      model: "gpt-3.5-turbo-0301",
      messages: [{ role: "user", content: prompt }]
    })
    .catch((err) => {
      console.error(err.message);
      console.error(err.response.data.error);
    });

  const answer = completion?.data?.choices[0]?.message?.content;
  if (!answer) return new Insight();

  try {
    const insight = JSON.parse(answer) as Insight;
    for (const _key in insight) {
      const key = _key as keyof Insight;
      const value = insight[key];
      if (Array.isArray(value)) insight[key] = value.filter((e) => e) as any;
    }
    return insight;
  } catch (error) {
    console.error("Failed to get insight");
    console.error(error);
    const id = Date.now();
    if (!fs.existsSync("./error_ai")) fs.mkdirSync("./error_ai");
    const errorContent = `Prompt: [${prompt}]` + "\n\n" + `Answer: [${answer}]`;
    fs.writeFile(`./error_ai/${id}`, errorContent, (err) => {
      if (err) throw err;
    });
    return new Insight();
  }
};
