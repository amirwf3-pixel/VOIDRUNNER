/**
 * Progression runtime: XP/levels, permanent upgrade purchases, run reward
 * settlement and the account-level bonus aggregation.
 *
 * This module owns *all* rules about how a run converts into permanent
 * progress, which makes the extraction stakes explicit and testable.
 */

import {
  DEATH_SALVAGE_BASE,
  META_UPGRADES,
  accountLevelBonus,
  aggregateUpgrades,
  upgradeById,
  upgradeCost,
  xpForLevel,
} from '../config/balance.js';

export class Progression {
  /**
   * @param {ReturnType<import('../save/save.js').defaultProfile>} profile
   */
  constructor(profile) {
    if (!profile || !profile.account) throw new TypeError('Progression requires a profile');
    this.profile = profile;
    this.pendingLevelUps = 0;
  }

  get level() {
    return this.profile.account.level;
  }

  get cores() {
    return this.profile.account.cores;
  }

  /** Bonuses from permanent upgrades + account level, applied to a new run. */
  computeRunBonuses() {
    const meta = aggregateUpgrades(this.profile.upgrades);
    const levelBonus = accountLevelBonus(this.profile.account.level);
    return {
      maxHealthAdd: meta.healthAdd + levelBonus.healthAdd,
      maxArmorAdd: meta.armorAdd,
      maxEnergyAdd: meta.energyAdd + levelBonus.energyAdd,
      moveMul: meta.moveMul,
      reloadMul: meta.reloadMul,
      recoilMul: meta.recoilMul,
      damageMul: meta.damageMul * levelBonus.damageMul,
      ammoMul: meta.ammoMul,
      magBonus: meta.magBonus,
      lootMul: meta.lootMul * levelBonus.lootMul,
      coreMul: meta.coreMul,
      medkitsAdd: meta.medkitsAdd,
      salvageAdd: meta.salvageAdd,
      meta,
    };
  }

  /**
   * Award XP. Returns how many levels were gained so the UI can react.
   * `onLevelUp` is invoked once per level so callers can play a sound.
   */
  addXp(amount, onLevelUp = null) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new RangeError(`addXp expects a non-negative finite number, got ${amount}`);
    }
    const account = this.profile.account;
    account.xp += Math.round(amount);
    let gained = 0;
    while (account.level < 60) {
      const needed = xpForLevel(account.level);
      if (account.xp < needed) break;
      account.xp -= needed;
      account.level += 1;
      gained += 1;
      this.pendingLevelUps += 1;
      if (onLevelUp) onLevelUp(account.level);
    }
    return gained;
  }

  /** XP bar data for the HUD and the post-run screen. */
  xpProgress() {
    const account = this.profile.account;
    const needed = xpForLevel(account.level);
    return {
      level: account.level,
      current: account.xp,
      needed,
      ratio: needed > 0 ? Math.min(1, account.xp / needed) : 1,
    };
  }

  canAfford(upgradeId, times = 1) {
    const upgrade = upgradeById(upgradeId);
    let rank = this.profile.upgrades[upgradeId] ?? 0;
    let total = 0;
    for (let i = 0; i < times; i += 1) {
      if (rank >= upgrade.maxRank) break;
      total += upgradeCost(upgrade, rank);
      rank += 1;
    }
    if (total === 0) return { ok: false, reason: 'MAX', cost: 0 };
    if (this.profile.account.cores < total) return { ok: false, reason: 'CORES', cost: total };
    return { ok: true, cost: total };
  }

  purchase(upgradeId, times = 1) {
    const upgrade = upgradeById(upgradeId);
    const check = this.canAfford(upgradeId, times);
    if (!check.ok) return check;
    let rank = this.profile.upgrades[upgradeId] ?? 0;
    let spent = 0;
    for (let i = 0; i < times; i += 1) {
      if (rank >= upgrade.maxRank) break;
      const cost = upgradeCost(upgrade, rank);
      if (this.profile.account.cores < cost) break;
      this.profile.account.cores -= cost;
      rank += 1;
      spent += cost;
    }
    this.profile.upgrades[upgradeId] = rank;
    return { ok: true, cost: spent, rank };
  }

  resetUpgrades() {
    const refund = META_UPGRADES.reduce((total, upgrade) => {
      const rank = Math.min(this.profile.upgrades[upgrade.id] ?? 0, upgrade.maxRank);
      let sum = 0;
      for (let i = 0; i < rank; i += 1) sum += upgradeCost(upgrade, i);
      return total + sum;
    }, 0);
    this.profile.upgrades = {};
    this.profile.account.cores += refund;
    return refund;
  }

  /**
   * Converts a finished run into permanent progress.
   *
   * @param {Object} runResult
   * @param {boolean} runResult.extracted   true when the player extracted
   * @param {number} runResult.sector       deepest sector reached
   * @param {number} runResult.xp
   * @param {number} runResult.cores        raw cores found in the run
   * @param {number} runResult.kills
   * @param {number} runResult.elapsed
   * @param {number} runResult.damageDealt
   * @param {number} runResult.lootValue
   * @param {number} runResult.bossKills
   * @param {number} [runResult.salvageOnDeath] override for tests
   */
  settleRun(runResult) {
    const bonuses = this.computeRunBonuses();
    const salvageRate = runResult.extracted
      ? 1
      : Math.min(0.9, DEATH_SALVAGE_BASE + bonuses.salvageAdd);
    const coresBanked = Math.round(runResult.cores * bonuses.coreMul * salvageRate);
    const xpBanked = Math.round(runResult.xp * (runResult.extracted ? 1 : 0.4));

    const account = this.profile.account;
    account.cores += coresBanked;
    account.totalRuns += 1;
    account.totalKills += runResult.kills;
    account.totalBossKills += runResult.bossKills ?? 0;
    account.totalPlaytimeSeconds += runResult.elapsed;
    if (runResult.extracted) {
      account.successfulExtractions += 1;
      if (account.fastestExtraction === 0 || runResult.elapsed < account.fastestExtraction) {
        account.fastestExtraction = runResult.elapsed;
      }
    } else {
      account.deaths += 1;
    }
    if (runResult.sector > account.bestSector) account.bestSector = runResult.sector;
    if (runResult.damageDealt > account.highestDamageRun) account.highestDamageRun = runResult.damageDealt;
    if (runResult.lootValue > account.bestLootRun) account.bestLootRun = runResult.lootValue;

    const levelsGained = this.addXp(xpBanked);
    const summary = {
      extracted: runResult.extracted,
      salvageRate,
      coresFound: runResult.cores,
      coresBanked,
      xpEarned: runResult.xp,
      xpBanked,
      levelsGained,
      sector: runResult.sector,
      kills: runResult.kills,
      elapsed: runResult.elapsed,
      damageDealt: runResult.damageDealt,
      lootValue: runResult.lootValue,
      bossKills: runResult.bossKills ?? 0,
      accountLevel: account.level,
      timestamp: Date.now(),
      seed: runResult.seed,
    };
    this.profile.stats.lastRunSummary = summary;
    this.profile.stats.runsBySeed[runResult.seed] = (this.profile.stats.runsBySeed[runResult.seed] ?? 0) + 1;
    return summary;
  }

  /** Debug/QA helper surfaced in Settings, mirroring a "reset progress" action. */
  resetAccount() {
    this.profile.account = {
      level: 1,
      xp: 0,
      cores: 0,
      totalRuns: 0,
      successfulExtractions: 0,
      deaths: 0,
      bestSector: 0,
      totalKills: 0,
      totalBossKills: 0,
      fastestExtraction: 0,
      totalPlaytimeSeconds: 0,
      highestDamageRun: 0,
      bestLootRun: 0,
    };
    this.profile.upgrades = {};
    this.profile.run = null;
    this.profile.stats = { runsBySeed: {}, lastRunSummary: null };
  }
}
