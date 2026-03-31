import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatResponse {
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ProviderAdapter {
  chat(
    apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// OpenAI adapter
// ---------------------------------------------------------------------------

class OpenAIAdapter implements ProviderAdapter {
  async chat(
    apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): Promise<ChatResponse> {
    const client = new OpenAI({ apiKey });

    // Build system message: instruction + compiled context
    const systemContent = compiledContextText
      ? `${systemPrompt}\n\n${compiledContextText}`
      : systemPrompt;

    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemContent },
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      })),
    ];

    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o",
        messages: openaiMessages,
      });

      const choice = response.choices[0];
      return {
        content: choice?.message?.content ?? "",
        usage: response.usage
          ? {
              prompt_tokens: response.usage.prompt_tokens,
              completion_tokens: response.usage.completion_tokens,
              total_tokens: response.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown OpenAI error";
      throw new Error(`OpenAI adapter error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

class AnthropicAdapter implements ProviderAdapter {
  async chat(
    apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): Promise<ChatResponse> {
    const client = new Anthropic({ apiKey });

    // Build system message: instruction + compiled context
    const systemContent = compiledContextText
      ? `${systemPrompt}\n\n${compiledContextText}`
      : systemPrompt;

    // Anthropic expects messages to start with a user message
    // and does not include system messages in the messages array
    const anthropicMessages: Anthropic.MessageParam[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemContent,
        messages: anthropicMessages,
      });

      const textBlock = response.content.find((b) => b.type === "text");
      return {
        content: textBlock?.text ?? "",
        usage: {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens:
            response.usage.input_tokens + response.usage.output_tokens,
        },
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown Anthropic error";
      throw new Error(`Anthropic adapter error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const adapters: Record<string, ProviderAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
};

export function getAdapter(provider: string): ProviderAdapter {
  const adapter = adapters[provider.toLowerCase()];
  if (!adapter) {
    throw new Error(
      `Unknown provider "${provider}". Supported: ${Object.keys(adapters).join(", ")}`
    );
  }
  return adapter;
}
