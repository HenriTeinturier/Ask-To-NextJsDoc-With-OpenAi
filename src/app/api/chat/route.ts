import { Message, OpenAIStream, StreamingTextResponse } from "ai";
import { openai } from "@/lib/openai";
import { getNeon } from "@/lib/neon";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { format } from "path";

// Optional, but recommended: run on the edge runtime.
// See https://vercel.com/docs/concepts/functions/edge-functions
export const runtime = "edge";

const SYSTEM_MESSAGE = `
  Your role:
  You are NextJS Docs GPT, a chatbot that know up to date information about NextJS documentation.
  Your task is to create simple, easy to understand, responses to questions about NextJS.
  You are good in pedagogy and can explain complex topics in simple terms.
  You are a senior NextJS developer and have a deep understanding of the NextJS framework.

  Goal:
  Create a response to the user's question about React and NextJS.

  Criteria:
  To answer the question, you will be given a context of the documentation of the NextJS framework.
  You need to use this context to create a response to the user's question.
  The context  it s a text with tags for comprehension. 
  The tags are: [titre], [sous-titre], [paragraphe], [code], [lien], [image], [table], ...
  You need to use the context to create a response that is relevant to the user's question.
  Dont forget to use too the documentation of NextJS to create your response.
  Dont forget to use previous messages to create your response.


  Response format:
  * to the point
  * With examples
  * Using Markdown
  * Space Separated
`;

export async function POST(req: Request) {
  // Extract the `messages` from the body of the request
  const { messages } = (await req.json()) as { messages: Message[] };

  const userPromptHistoric = messages.filter((m) => m.role === "user");
  const userPromptHistoricContent = userPromptHistoric
    .map((m) => m.content)
    .toString();

  const lastMessage = messages[messages.length - 1];
  const userPrompt = lastMessage.content;

  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userPromptHistoricContent,
      encoding_format: "float",
    });

    const promptEmbedding = response.data[0].embedding;
    const promptEmbeddingFormatted = promptEmbedding
      .toString()
      .replace(/\.\.\./g, "");

    const sql = getNeon();

    const insertQuery = `
    SELECT text, file_path
    FROM (
      SELECT text, n_tokens, embeddings, file_path,
      (embeddings <=> '[${promptEmbeddingFormatted}]') AS distances,
      SUM(n_tokens) OVER (ORDER BY (embeddings <=> '[${promptEmbeddingFormatted}]')) as cum_n_tokens
      FROM documents
    ) subquery
    WHERE cum_n_tokens <= $1
    ORDER BY distances ASC;
  `;

    const MAX_TOKENS = 2500;
    const queryParams = [MAX_TOKENS];

    const result = (await sql(insertQuery, queryParams)) as {
      text: string;
      file_path: string;
    }[];

    const formattedResult = result.map((r) => {
      return {
        url:
          "source: " +
          "https://nextjs.org" +
          r.file_path.replaceAll("_", "/").replace(".txt", ""),
        content: r.text,
      };
    });

    const context = formattedResult.map((r) => {
      return `url: ${r.url}: "\n"context:  ${r.content}`;
    });

    const otherMessages = messages.slice(0, messages.length - 1).map((m) => {
      const mess: ChatCompletionMessageParam = {
        role: m.role as "assistant" | "user",
        content: String(m.content),
      };

      return mess;
    });

    const finalMessages: Array<ChatCompletionMessageParam> = [
      {
        role: "system",
        content: SYSTEM_MESSAGE,
      },
      ...otherMessages,
      {
        role: "system",
        content: "Context: " + context,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ];

    // very more efficient with gpt-4-0125-preview
    // models options:
    // gpt-4-0125-preview 	$10.00 / 1M tokens (input) $30.00 / 1M tokens (output)
    // gpt-3.5-turbo-0125 	$0.50 / 1M tokens (input)	$1.50 / 1M tokens (output)
    const openAiResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-0125",
      stream: true,
      max_tokens: 1000,
      messages: finalMessages,
    });

    const stream = OpenAIStream(openAiResponse);
    return new StreamingTextResponse(stream);
  } catch (error) {
    console.error("Error fetching prompt embedding", error);
  }
}
