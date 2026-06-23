import { describe, it, expect, vi } from "vitest";
import { ChannelRegistry, type ChannelAdapter } from "./channel-adapter.contract";
import type { ChannelType } from "../dialog/dialog.types";
import type { DialogInboundJob } from "../dialog-queue/dialog-inbound-job.types";

function fakeAdapter(channelId: ChannelType): ChannelAdapter {
  return {
    channelId,
    processInbound: vi.fn(async () => undefined),
    sendText: vi.fn(async () => true),
  };
}

describe("ChannelRegistry", () => {
  it("resolves adapters by channel id", () => {
    const tg = fakeAdapter("telegram");
    const wa = fakeAdapter("whatsapp");
    const reg = new ChannelRegistry([tg, wa]);
    expect(reg.get("telegram")).toBe(tg);
    expect(reg.get("whatsapp")).toBe(wa);
    expect(reg.ids().sort()).toEqual(["telegram", "whatsapp"]);
  });

  it("returns undefined for an unregistered channel", () => {
    const reg = new ChannelRegistry([fakeAdapter("telegram")]);
    expect(reg.get("whatsapp")).toBeUndefined();
  });

  it("dispatches a job to the matching adapter only", async () => {
    const tg = fakeAdapter("telegram");
    const wa = fakeAdapter("whatsapp");
    const reg = new ChannelRegistry([tg, wa]);
    const job = { channel: "telegram", botId: "b1", chatId: 1, text: "hi" } as DialogInboundJob;
    await reg.get(job.channel)?.processInbound(job);
    expect(tg.processInbound).toHaveBeenCalledWith(job);
    expect(wa.processInbound).not.toHaveBeenCalled();
  });
});
