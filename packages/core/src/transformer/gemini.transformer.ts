import { LLMProvider, UnifiedChatRequest } from "../types/llm";
import { Transformer } from "../types/transformer";
import {
  buildRequestBody,
  transformRequestOut,
  transformResponseOut,
} from "../utils/gemini.util";

export class GeminiTransformer implements Transformer {
  name = "gemini";

  endPoint = "/v1beta/models/:modelAndAction";

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider
  ): Promise<Record<string, any>> {
    return {
      body: buildRequestBody(request),
      config: {
        url: new URL(
          `./${request.model}:${
            request.stream ? "streamGenerateContent?alt=sse" : "generateContent"
          }`,
          provider.baseUrl
        ),
        headers: {
          "x-goog-api-key": provider.apiKey,
          Authorization: undefined,
          // undici does not transparently gunzip responses fetched through a
          // ProxyAgent (see BaseQuotaAdapter): a gzipped body arrives with no
          // usable Content-Type, the gateway's JSON validation fails on the
          // gzip magic and serves mangled binary as a 400. Ask the upstream
          // for an uncompressed payload so the proxy path behaves like direct.
          "Accept-Encoding": "identity",
        },
      },
    };
  }

  transformRequestOut = transformRequestOut;

  async transformResponseOut(response: Response): Promise<Response> {
    return transformResponseOut(response, this.name, this.logger);
  }
}
