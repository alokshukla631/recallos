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

  chatStream(
    apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): AsyncGenerator<string, ChatResponse, unknown>;
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

  async *chatStream(
    apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): AsyncGenerator<string, ChatResponse, unknown> {
    const client = new OpenAI({ apiKey });

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

    let full = "";
    let usage: ChatResponse["usage"] = undefined;

    try {
      const stream = await client.chat.completions.create({
        model: "gpt-4o",
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          yield delta;
        }
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          };
        }
      }

      return { content: full, usage };
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

  async *chatStream(
    apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): AsyncGenerator<string, ChatResponse, unknown> {
    const client = new Anthropic({ apiKey });

    const systemContent = compiledContextText
      ? `${systemPrompt}\n\n${compiledContextText}`
      : systemPrompt;

    const anthropicMessages: Anthropic.MessageParam[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    let full = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const stream = client.messages.stream({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemContent,
        messages: anthropicMessages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const delta = event.delta.text;
          if (delta) {
            full += delta;
            yield delta;
          }
        } else if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === "message_delta") {
          outputTokens = event.usage.output_tokens;
        }
      }

      return {
        content: full,
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
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
// Gemini adapter (uses REST API directly)
// ---------------------------------------------------------------------------

class GeminiAdapter implements ProviderAdapter {
  private baseUrl = "https://generativelanguage.googleapis.com/v1beta";

  async chat(
    apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): Promise<ChatResponse> {
    const systemContent = compiledContextText
      ? `${systemPrompt}\n\n${compiledContextText}`
      : systemPrompt;

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body = {
      system_instruction: { parts: [{ text: systemContent }] },
      contents,
    };

    try {
      const res = await fetch(
        `${this.baseUrl}/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini API error (${res.status}): ${err}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const usage = data.usageMetadata;

      return {
        content: text,
        usage: usage ? {
          prompt_tokens: usage.promptTokenCount,
          completion_tokens: usage.candidatesTokenCount,
          total_tokens: usage.totalTokenCount,
        } : undefined,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown Gemini error";
      throw new Error(`Gemini adapter error: ${message}`);
    }
  }

  async *chatStream(
    apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): AsyncGenerator<string, ChatResponse, unknown> {
    // Gemini streaming uses SSE with streamGenerateContent
    const systemContent = compiledContextText
      ? `${systemPrompt}\n\n${compiledContextText}`
      : systemPrompt;

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body = {
      system_instruction: { parts: [{ text: systemContent }] },
      contents,
    };

    try {
      const res = await fetch(
        `${this.baseUrl}/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok || !res.body) {
        const err = await res.text();
        throw new Error(`Gemini API error (${res.status}): ${err}`);
      }

      let full = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
              if (text) {
                full += text;
                yield text;
              }
            } catch {
              // ignore malformed chunks
            }
          }
        }
      }

      return { content: full };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown Gemini error";
      throw new Error(`Gemini adapter error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ollama adapter (local models via REST API)
// ---------------------------------------------------------------------------

class OllamaAdapter implements ProviderAdapter {
  private baseUrl = process.env.OLLAMA_URL || "http://localhost:11434";

  async chat(
    _apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): Promise<ChatResponse> {
    const systemContent = compiledContextText
      ? `${systemPrompt}\n\n${compiledContextText}`
      : systemPrompt;

    const ollamaMessages = [
      { role: "system", content: systemContent },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const model = process.env.OLLAMA_MODEL || "llama3.2";

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: ollamaMessages, stream: false }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Ollama error (${res.status}): ${err}`);
      }

      const data = await res.json();
      return {
        content: data.message?.content ?? "",
        usage: data.eval_count ? {
          prompt_tokens: data.prompt_eval_count,
          completion_tokens: data.eval_count,
          total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        } : undefined,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown Ollama error";
      throw new Error(`Ollama adapter error: ${message}`);
    }
  }

  async *chatStream(
    _apiKey: string,
    systemPrompt: string,
    messages: ChatMessage[],
    compiledContextText: string
  ): AsyncGenerator<string, ChatResponse, unknown> {
    const systemContent = compiledContextText
      ? `${systemPrompt}\n\n${compiledContextText}`
      : systemPrompt;

    const ollamaMessages = [
      { role: "system", content: systemContent },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const model = process.env.OLLAMA_MODEL || "llama3.2";

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: ollamaMessages, stream: true }),
      });

      if (!res.ok || !res.body) {
        const err = await res.text();
        throw new Error(`Ollama error (${res.status}): ${err}`);
      }

      let full = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const text = data.message?.content ?? "";
            if (text) {
              full += text;
              yield text;
            }
          } catch {
            // ignore
          }
        }
      }

      return { content: full };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown Ollama error";
      throw new Error(`Ollama adapter error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const adapters: Record<string, ProviderAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
  ollama: new OllamaAdapter(),
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
