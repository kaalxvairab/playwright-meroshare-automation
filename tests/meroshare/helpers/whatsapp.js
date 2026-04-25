/**
 * WhatsApp helper functions for notifications via CallMeBot WhatsApp API
 */

let whatsappConfig = null;

/**
 * Initialize WhatsApp config
 * @param {Object} config
 * @returns {boolean} true when enabled and configured, false otherwise
 */
function initWhatsApp(config = {}) {
  console.log("[WhatsApp] Initializing with config:", {
    hasConfigEnabled: config.enabled !== undefined,
    hasEnvEnabled: process.env.WHATSAPP_ENABLED !== undefined,
    hasConfigPhone: config.phone !== undefined,
    hasEnvPhone: process.env.WHATSAPP_TO !== undefined,
    hasConfigApiKey: config.apiKey !== undefined,
    hasEnvApiKey: process.env.WHATSAPP_CALLMEBOT_API_KEY !== undefined,
  });

  const enabled =
    String(
      config.enabled ?? process.env.WHATSAPP_ENABLED ?? "false",
    ).toLowerCase() === "true";

  if (!enabled) {
    console.log("[WhatsApp] WhatsApp is disabled");
    whatsappConfig = { enabled: false };
    return false;
  }

  console.log("[WhatsApp] WhatsApp is enabled, checking credentials...");

  const endpoint = config.endpoint || process.env.WHATSAPP_CALLMEBOT_URL;
  const phone = config.phone || process.env.WHATSAPP_TO;
  const apiKey = config.apiKey || process.env.WHATSAPP_CALLMEBOT_API_KEY;

  if (!phone || !apiKey) {
    console.error(
      "[WhatsApp] CRITICAL: WhatsApp is enabled but missing CallMeBot configuration (WHATSAPP_TO and WHATSAPP_CALLMEBOT_API_KEY).",
    );
    whatsappConfig = { enabled: false };
    return false;
  }

  whatsappConfig = {
    enabled: true,
    endpoint,
    phone: String(phone).replace(/\D/g, ""),
    apiKey,
  };

  console.log("[WhatsApp] Configuration loaded successfully", {
    phone: whatsappConfig.phone,
    endpoint: whatsappConfig.endpoint ? "configured" : "not configured",
  });

  return true;
}

function formatForWhatsApp(message) {
  return String(message || "")
    .replace(/\*/g, "")
    .replace(/_/g, "")
    .replace(/`/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function splitWhatsAppMessage(message, chunkSize = 900) {
  const clean = formatForWhatsApp(message);

  if (clean.length <= chunkSize) {
    return [clean];
  }

  const chunks = [];
  let current = "";
  const lines = clean.split("\n");

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (line.length <= chunkSize) {
      current = line;
      continue;
    }

    for (let i = 0; i < line.length; i += chunkSize) {
      chunks.push(line.slice(i, i + chunkSize));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function sendViaCallMeBot(message, retryCount = 0, maxRetries = 4) {
  const endpoint = String(whatsappConfig.endpoint || "").trim();
  const baseUrl = endpoint.includes("whatsapp.php")
    ? endpoint
    : `${endpoint.replace(/\/$/, "")}/whatsapp.php`;

  const query = new URLSearchParams({
    phone: whatsappConfig.phone,
    text: message,
    apikey: whatsappConfig.apiKey,
  });

  const url = `${baseUrl}?${query.toString()}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // 20 second timeout for scheduled runs

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.callmebot.com/blog/free-api-whatsapp-messages/",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    clearTimeout(timeout);

    const rawBody = await response.text();
    const body = rawBody.trim();
    const bodyLower = body.toLowerCase();
    const hasOutageSignal =
      bodyLower.includes("service is down") || bodyLower.includes("(410)");
    const hasFailureSignal =
      hasOutageSignal ||
      bodyLower.includes("error") ||
      bodyLower.includes("invalid") ||
      bodyLower.includes("unauthorized");
    const hasSuccessSignal =
      bodyLower.includes("sent") ||
      bodyLower.includes("message to:") ||
      bodyLower.includes("text to send:") ||
      bodyLower.includes("queued");

    // 403 Forbidden can be temporary IP reputation issue in scheduled runs - treat as potentially retryable
    if (response.status === 403) {
      throw new Error(
        `CallMeBot IP blocked (${response.status}): Temporary access restriction - will retry`,
      );
    }

    if (hasOutageSignal) {
      throw new Error(
        `CallMeBot service outage detected (${response.status}): ${body || "No response body"}`,
      );
    }

    if (!response.ok || hasFailureSignal || !hasSuccessSignal) {
      throw new Error(
        `CallMeBot send failed (${response.status}): ${body || "No response body"}`,
      );
    }

    console.log(
      `[WhatsApp] Message sent successfully on attempt ${retryCount + 1}`,
    );
  } catch (error) {
    const isRetryable =
      error.name === "AbortError" ||
      error.message.includes("CallMeBot service outage") ||
      error.message.includes("IP blocked") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ETIMEDOUT");
    const shouldRetry = isRetryable && retryCount < maxRetries;

    console.error(
      `[WhatsApp] Attempt ${retryCount + 1}/${maxRetries + 1} failed: ${error.message}`,
    );

    if (shouldRetry) {
      // Longer exponential backoff for scheduled runs: 2s, 4s, 8s, 16s
      const delayMs = Math.pow(2, retryCount + 1) * 1000;
      console.log(`[WhatsApp] Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return sendViaCallMeBot(message, retryCount + 1, maxRetries);
    } else {
      throw error;
    }
  }
}

/**
 * Send plain text message to WhatsApp
 * @param {string} message
 * @returns {Promise<boolean>} true if sent successfully, false otherwise
 */
async function sendWhatsAppText(message) {
  // Ensure environment variables are properly loaded
  if (!whatsappConfig) {
    const initialized = initWhatsApp();
    if (!initialized) {
      console.warn("[WhatsApp] WhatsApp not initialized or enabled");
      return false;
    }
  }

  if (!whatsappConfig || !whatsappConfig.enabled) {
    console.warn("[WhatsApp] WhatsApp is not enabled");
    return false;
  }

  try {
    const chunks = splitWhatsAppMessage(message);
    console.log(`[WhatsApp] Sending ${chunks.length} chunk(s)`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(
        `[WhatsApp] Sending chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`,
      );
      await sendViaCallMeBot(chunk);
    }

    console.log(`[WhatsApp] All ${chunks.length} chunk(s) sent successfully`);
    return true;
  } catch (error) {
    console.error("[WhatsApp] FAILED to send WhatsApp message:", {
      message: error.message,
      stack: error.stack,
    });
    return false;
  }
}

async function notifyIPOStatusWhatsApp(status, details = "") {
  const emoji = status === "success" ? "✅" : status === "failed" ? "❌" : "⚠️";
  const message = `${emoji} IPO Application ${status.toUpperCase()}\n\n${details}\nTime: ${new Date().toLocaleString()}`;
  await sendWhatsAppText(message);
}

async function notifyErrorWhatsApp(error) {
  const message = `❌ Error Occurred\n\nError: ${error}\nTime: ${new Date().toLocaleString()}`;
  await sendWhatsAppText(message);
}

async function notifyIPONotFoundWhatsApp() {
  await sendWhatsAppText("ℹ️ No IPO Today 🤦‍♀️");
}

async function notifyIPOOpenForReviewWhatsApp(details) {
  let message = "🚀 IPO Open\n\n";

  if (details.companyName) {
    message += `Company: ${details.companyName}\n`;
  }
  if (
    details.shareValuePerUnit !== undefined &&
    details.shareValuePerUnit !== null
  ) {
    message += `Share Value Per Unit: ${details.shareValuePerUnit}\n`;
  }
  if (details.minUnit !== undefined && details.minUnit !== null) {
    message += `Min Unit: ${details.minUnit}\n`;
  }

  message += "\n⚠️ Not auto-applied\n";
  if (details.reason) {
    message += `${details.reason}\n`;
  }

  message += `\nTime: ${new Date().toLocaleString()}`;

  await sendWhatsAppText(message);
}

module.exports = {
  initWhatsApp,
  sendWhatsAppText,
  notifyIPOStatusWhatsApp,
  notifyErrorWhatsApp,
  notifyIPONotFoundWhatsApp,
  notifyIPOOpenForReviewWhatsApp,
  formatForWhatsApp,
};
