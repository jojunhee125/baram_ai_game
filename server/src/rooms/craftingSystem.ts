import { ServerMessage, type CraftingRecipeView, type CraftResult } from "@zep-test/shared";
import type { SettlementStore } from "../db/settlementStore";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import { objectPayload, refreshEconomy, SocialBudget, type SocialHost } from "./socialRuntime";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ingredient = (itemKey: string, quantity: number) => ({
  itemKey, quantity, name: ITEM_DEFINITIONS.find((item) => item.key === itemKey)!.name,
});
export const CRAFTING_RECIPES: readonly CraftingRecipeView[] = [{
  recipeId: "reinforced-armor", name: "강화 가죽갑옷 제작", currencyCost: 30,
  ingredients: [ingredient("padded-armor", 1), ingredient("den-fur", 3)], output: ingredient("reinforced-armor", 1),
}];

export class CraftingSystem {
  private readonly budget = new SocialBudget();
  private readonly pending = new Set<string>();
  private disposed = false;

  constructor(private readonly host: SocialHost, private readonly store: SettlementStore | null) {}

  join(sessionId: string): void {
    this.host.send(sessionId, ServerMessage.CraftingRecipes, { recipes: this.store === null ? [] : CRAFTING_RECIPES });
  }

  craft(sessionId: string, message: unknown, now: number): void {
    const actor = this.host.actor(sessionId);
    if (this.disposed || actor === undefined) return;
    const recipeId = objectPayload(message) && typeof message.recipeId === "string" ? message.recipeId.slice(0, 128) : "";
    const nonce = objectPayload(message) && typeof message.nonce === "string" ? message.nonce.slice(0, 128) : "";
    const result = (reason: CraftResult["reason"]) => this.host.send(sessionId, ServerMessage.CraftResult, { recipeId, nonce, ok: false, reason });
    if (!this.budget.take(sessionId, "craft", now)) return result("rate-limited");
    if (!objectPayload(message) || typeof message.recipeId !== "string" || message.recipeId.length > 128 ||
        typeof message.nonce !== "string" || !UUID_PATTERN.test(message.nonce)) return result("invalid-request");
    const recipe = CRAFTING_RECIPES.find((candidate) => candidate.recipeId === recipeId);
    if (recipe === undefined) return result("unknown-recipe");
    if (actor.ownerKey === null || !UUID_PATTERN.test(actor.ownerKey)) return result("auth-required");
    if (this.store === null) return result("unavailable");
    const ownerKey = actor.ownerKey.toLowerCase();
    if (this.pending.has(ownerKey)) return result("rate-limited");
    this.pending.add(ownerKey);
    void this.settle(sessionId, ownerKey, recipe, nonce);
  }

  private async settle(sessionId: string, ownerKey: string, recipe: CraftingRecipeView, nonce: string): Promise<void> {
    let response: CraftResult;
    try {
      const outcome = await this.store!.settle(`craft:${ownerKey}:${recipe.recipeId}:${nonce.toLowerCase()}`, ownerKey, {
        currencyDelta: -recipe.currencyCost,
        itemDebits: recipe.ingredients.map(({ itemKey, quantity }) => ({ itemKey, quantity })),
        items: [{ itemKey: recipe.output.itemKey, quantity: recipe.output.quantity }],
      });
      response = { recipeId: recipe.recipeId, nonce, ok: outcome.ok, ...(!outcome.ok ? { reason: outcome.reason } : {}) };
      if (outcome.ok) await refreshEconomy([ownerKey], "craft");
    } catch (cause) {
      console.warn(`[zep-test] could not craft ${recipe.recipeId} for ${ownerKey}`, cause);
      response = { recipeId: recipe.recipeId, nonce, ok: false, reason: "storage-error" };
    } finally { this.pending.delete(ownerKey); }
    if (!this.disposed && this.host.actor(sessionId)?.ownerKey?.toLowerCase() === ownerKey) {
      this.host.send(sessionId, ServerMessage.CraftResult, response);
    }
  }

  remove(sessionId: string): void { this.budget.remove(sessionId); }
  dispose(): void { this.disposed = true; this.budget.clear(); }
}
