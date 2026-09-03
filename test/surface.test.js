const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const protocol = require("../src/openai-protocol");
const map = require("../src/openai-map");
const converter = require("../src/converter");

describe("output limits from the request", () => {
  it("reads either spelling of the token cap, preferring the newer one", () => {
    assert.equal(protocol.outputLimits({ max_tokens: 50 }).maxTokens, 50);
    assert.equal(protocol.outputLimits({ max_completion_tokens: 70 }).maxTokens, 70);
    assert.equal(
      protocol.outputLimits({ max_completion_tokens: 70, max_tokens: 50 }).maxTokens,
      70
    );
  });

  it("accepts stop as a string or an array", () => {
    assert.deepEqual(protocol.outputLimits({ stop: "END" }).stops, ["END"]);
    assert.deepEqual(protocol.outputLimits({ stop: ["A", "B"] }).stops, ["A", "B"]);
    assert.deepEqual(protocol.outputLimits({}).stops, []);
  });

  it("ignores a nonsense cap", () => {
    assert.equal(protocol.outputLimits({ max_tokens: 0 }).maxTokens, 0);
    assert.equal(protocol.outputLimits({ max_tokens: -5 }).maxTokens, 0);
    assert.equal(protocol.outputLimits({ max_tokens: "many" }).maxTokens, 0);
  });
});

describe("finish_reason", () => {
  it("says length when the answer was capped", () => {
    assert.equal(protocol.finishReasonFor({ cutReason: "length" }, false), "length");
    assert.equal(protocol.finishReasonFor({ cutReason: "length" }, true), "length");
  });

  it("says stop for a stop sequence, because the model did end there", () => {
    assert.equal(protocol.finishReasonFor({ cutReason: "stop_sequence" }, false), "stop");
  });

  it("reports tool_calls and plain stop otherwise", () => {
    assert.equal(protocol.finishReasonFor({}, true), "tool_calls");
    assert.equal(protocol.finishReasonFor({}, false), "stop");
    assert.equal(protocol.finishReasonFor(undefined, false), "stop");
  });

  it("carries into the non-streaming body", () => {
    const body = converter.buildChatResponse("half an answ", "m", 1, 2, {
      usageDetails: { cutReason: "length" },
    });
    assert.equal(body.choices[0].finish_reason, "length");
  });
});

describe("message content normalization", () => {
  it("reads every text-bearing part shape", () => {
    assert.equal(map.contentToText("plain"), "plain");
    assert.equal(map.contentToText([{ type: "text", text: "a" }]), "a");
    assert.equal(map.contentToText([{ type: "input_text", text: "b" }]), "b");
    assert.equal(map.contentToText([{ type: "output_text", text: "c" }]), "c");
    assert.equal(map.contentToText(["raw"]), "raw");
  });

  it("announces what it cannot carry instead of dropping it", () => {
    assert.match(map.contentToText([{ type: "image_url", image_url: {} }]), /image omitted/);
    assert.match(map.contentToText([{ type: "input_image" }]), /image omitted/);
    assert.match(map.contentToText([{ type: "input_audio" }]), /audio omitted/);
    assert.match(
      map.contentToText([{ type: "input_file", file: { filename: "spec.pdf" } }]),
      /file omitted: spec\.pdf/
    );
    assert.match(map.contentToText([{ type: "refusal", refusal: "no" }]), /\[refused\] no/);
  });

  it("keeps a refusal-only assistant turn in the transcript", () => {
    const prompt = map.messagesToPrompt([
      { role: "user", content: "do it" },
      { role: "assistant", content: null, refusal: "I cannot help with that" },
      { role: "user", content: "why" },
    ]);
    assert.match(prompt, /I cannot help with that/);
  });

  it("pairs tool calls with their results by id", () => {
    const prompt = map.messagesToPrompt([
      { role: "user", content: "weather" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_a", function: { name: "get", arguments: '{"c":"TP"}' } },
          { id: "call_b", function: { name: "get", arguments: '{"c":"OS"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "31" },
      { role: "tool", tool_call_id: "call_b", content: "27" },
    ]);
    assert.match(prompt, /tool_call_id=call_a/);
    assert.match(prompt, /tool_call_id=call_b/);
    assert.match(prompt, /<tool_result tool_call_id="call_a">/);
    assert.match(prompt, /<tool_result tool_call_id="call_b">/);
  });
});

describe("ignored parameters", () => {
  it("does not ignore temperature and top_p now that model_config takes them", () => {
    const ignored = map.ignoredOpenAIParams({ temperature: 0.2, top_p: 0.9, seed: 7 });
    assert.equal(ignored.includes("temperature"), false);
    assert.equal(ignored.includes("top_p"), false);
    assert.ok(ignored.includes("seed"));
  });

  it("stays quiet about parameters the caller did not send", () => {
    assert.deepEqual(map.ignoredOpenAIParams({ model: "m" }), []);
  });
});

describe("tool_trace", () => {
  it("stays out of the response unless debugging is on", () => {
    const body = converter.buildChatResponse("hi", "m", 1, 1, {
      toolTrace: [{ name: "read", args: { path: "/etc/passwd" } }],
    });
    assert.equal(body.tool_trace, undefined);
  });
});

describe("prompt hints", () => {
  it("tells the model about a cap it will otherwise be cut against", () => {
    const hint = protocol.hintPrefix({ max_tokens: 50, stop: ["END"] });
    assert.match(hint, /50 tokens/);
    assert.match(hint, /END/);
  });

  it("does not spend prompt tokens restating temperature", () => {
    assert.equal(protocol.hintPrefix({ temperature: 0.1 }), "");
  });

  it("keeps the response_format instruction, which is prompt-only by nature", () => {
    assert.match(protocol.hintPrefix({ response_format: { type: "json_object" } }), /JSON object/);
  });
});
