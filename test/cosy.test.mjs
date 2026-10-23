import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildQoderAuthHeaders,
  computeQoderSigPath,
  getQoderCNPat,
  isQoderPatValue,
  parseQoderVPCInstance,
  qoderChatUrl,
  qoderCnEndpoints,
  qoderModelListUrl,
  resolveQoderEndpoints,
} from "../dist/cosy.js";

const ENV_NAMES = [
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
  "QODER_API_KEY",
  "QODER_VPC_INSTANCE",
  "QODER_VPC_ENDPOINT",
  "QODERCN_VPC_ENDPOINT",
  "QODERCN_CLI_VPC_ENDPOINT",
  "QODER_CN_BASE_URL",
  "QODER_CN_OPENAPI_URL",
  "QODER_CN_CENTER_URL",
  "QODER_GATEWAY_URL",
  "QODER_GATEWAY",
  "QODER_OPENAPI_URL",
  "QODER_OPENAPI",
  "QODER_MANAGE_URL",
  "QODER_MANAGE",
];

function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("parses VPC instance names from every accepted form", () => {
  assert.equal(parseQoderVPCInstance("acme"), "acme");
  assert.equal(parseQoderVPCInstance("acme-gateway.vpc.qoder.com.cn"), "acme");
  assert.equal(parseQoderVPCInstance("https://acme-openapi.vpc.qoder.com.cn"), "acme");
  assert.equal(parseQoderVPCInstance("acme.vpc.qoder.com.cn"), "acme");
  assert.equal(parseQoderVPCInstance("gateway.qoder.com.cn"), undefined);
  assert.equal(parseQoderVPCInstance(""), undefined);
  assert.equal(parseQoderVPCInstance("not a host!"), undefined);
});

test("derives public and VPC endpoint sets", () => {
  assert.deepEqual(qoderCnEndpoints(), {
    gateway: "https://gateway.qoder.com.cn",
    openapi: "https://openapi.qoder.com.cn",
    manage: "https://qoder.com.cn",
  });
  assert.deepEqual(qoderCnEndpoints("acme"), {
    gateway: "https://acme-gateway.vpc.qoder.com.cn",
    openapi: "https://acme-openapi.vpc.qoder.com.cn",
    manage: "https://acme.vpc.qoder.com.cn",
  });
});

test("resolves endpoints from explicit env, VPC env, and baseURL", () => {
  withEnv({}, () => {
    assert.equal(resolveQoderEndpoints().gateway, "https://gateway.qoder.com.cn");
    assert.equal(
      resolveQoderEndpoints("https://acme-gateway.vpc.qoder.com.cn").gateway,
      "https://acme-gateway.vpc.qoder.com.cn",
    );
  });

  withEnv({ QODER_VPC_INSTANCE: "acme" }, () => {
    assert.equal(
      resolveQoderEndpoints().gateway,
      "https://acme-gateway.vpc.qoder.com.cn",
    );
    assert.equal(
      resolveQoderEndpoints().openapi,
      "https://acme-openapi.vpc.qoder.com.cn",
    );
  });

  withEnv(
    {
      QODER_GATEWAY_URL: "https://gateway.example.test/",
      QODER_OPENAPI_URL: "https://openapi.example.test/",
    },
    () => {
      assert.deepEqual(resolveQoderEndpoints(), {
        gateway: "https://gateway.example.test",
        openapi: "https://openapi.example.test",
        manage: "https://qoder.com.cn",
      });
    },
  );
});

test("builds the exact chat and model-list URLs", () => {
  const endpoints = qoderCnEndpoints();
  assert.equal(
    qoderChatUrl(endpoints),
    "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
  );
  assert.equal(
    qoderModelListUrl(endpoints),
    "https://gateway.qoder.com.cn/algo/api/v2/model/list",
  );
});

test("strips the /algo prefix from the signed path", () => {
  assert.equal(
    computeQoderSigPath(
      "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?x=1",
    ),
    "/api/v2/service/pro/sse/agent_chat_generation",
  );
  assert.equal(
    computeQoderSigPath("https://gateway.qoder.com.cn/api/v2/model/list"),
    "/api/v2/model/list",
  );
});

test("resolves PATs with the documented precedence", () => {
  withEnv({}, () => {
    assert.equal(getQoderCNPat(), "");
    assert.equal(isQoderPatValue("pt-abc"), true);
    assert.equal(isQoderPatValue("jt-abc"), false);
  });

  withEnv({ QODERCN_PERSONAL_ACCESS_TOKEN: " pt-dedicated " }, () => {
    assert.equal(getQoderCNPat(), "pt-dedicated");
  });

  withEnv({ QODERCN_PAT: "pt-fallback" }, () => {
    assert.equal(getQoderCNPat(), "pt-fallback");
  });

  withEnv({ QODER_API_KEY: "pt-api-key" }, () => {
    assert.equal(getQoderCNPat(), "pt-api-key");
  });

  withEnv({ QODER_API_KEY: "sk-not-a-pat" }, () => {
    assert.equal(getQoderCNPat(), "");
  });
});

test("COSY headers sign the WAF-encoded body", () => {
  const body = "encoded-waf-body";
  const url =
    "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1";
  const headers = buildQoderAuthHeaders(body, url, {
    userID: "user-123",
    authToken: "jt-token",
    name: "Test User",
    email: "test@example.com",
    machineID: "machine-123",
  });

  assert.equal(headers["Cosy-User"], "user-123");
  assert.equal(headers["Cosy-Machineid"], "machine-123");
  assert.equal(headers["Cosy-Machinetoken"], "machine-123");
  assert.equal(headers["Cosy-Bodylength"], String(Buffer.byteLength(body)));
  assert.equal(
    headers["Cosy-Bodyhash"],
    crypto.createHash("md5").update(body).digest("hex"),
  );
  assert.equal(
    headers["Cosy-Sigpath"],
    "/api/v2/service/pro/sse/agent_chat_generation",
  );
  assert.match(headers["Cosy-Date"], /^\d+$/);
  assert.ok(headers["Cosy-Key"].length > 0);

  const match = /^Bearer COSY\.([^.]+)\.([0-9a-f]+)$/.exec(
    headers.Authorization,
  );
  assert.ok(match, "Authorization must be a COSY bearer");
  const [, payloadB64, signature] = match;
  const signed = [
    payloadB64,
    headers["Cosy-Key"],
    headers["Cosy-Date"],
    body,
    headers["Cosy-Sigpath"],
  ].join("\n");
  assert.equal(
    signature,
    crypto.createHash("md5").update(signed).digest("hex"),
  );

  const payload = JSON.parse(
    Buffer.from(payloadB64, "base64").toString("utf8"),
  );
  assert.equal(payload.version, "v1");
  assert.equal(payload.cosyVersion, "1.0.0");
  assert.ok(payload.info.length > 0);
  assert.ok(payload.requestId.length > 0);
});

test("COSY headers reject an empty identity", () => {
  assert.throws(
    () =>
      buildQoderAuthHeaders("body", "https://gateway.qoder.com.cn/algo/x", {
        userID: "",
        authToken: "jt-token",
        name: "",
        email: "",
        machineID: "m",
      }),
    /user id is empty/,
  );
  assert.throws(
    () =>
      buildQoderAuthHeaders("body", "https://gateway.qoder.com.cn/algo/x", {
        userID: "u",
        authToken: "",
        name: "",
        email: "",
        machineID: "m",
      }),
    /auth token is empty/,
  );
});
