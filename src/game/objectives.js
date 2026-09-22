/**
 * Objective runtime.
 *
 * Objectives are data (type + target + markers). This module owns progress,
 * completion, HUD text and the marker props/entities that objectives need to
 * exist in the world (reactor props, data shard pickups).
 */

import { dist2 } from '../core/math.js';
import { OBJECTIVE_TYPES } from '../config/balance.js';

export class ObjectiveRuntime {
  /**
   * @param {ReturnType<import('../generation/zone.js').generateZone>} zone
   */
  constructor(zone) {
    this.objectives = zone.objectives.map((def) => ({
      ...def,
      progress: 0,
      complete: false,
      // Markers keep a stable definition id so progress can be reported before
      // (or without) the shard drops existing; `dropId` is filled in later by
      // spawnMarkers and links a collected drop back to its marker.
      markers: (def.markers ?? []).map((m, index) => ({
        ...m,
        collected: false,
        id: `${def.id}:marker:${index}`,
        dropId: null,
      })),
      completionTime: 0,
    }));
    this.allComplete = false;
    this.onProgress = null;
    this.onComplete = null;
    this.onAllComplete = null;
  }

  get main() {
    return this.objectives[0] ?? null;
  }

  get activeObjectives() {
    return this.objectives.filter((o) => !o.complete);
  }

  get progressRatio() {
    if (this.objectives.length === 0) return 1;
    const total = this.objectives.reduce((sum, o) => sum + Math.min(1, o.progress / o.target), 0);
    return total / this.objectives.length;
  }

  /** Marks the shard pickups so the loot system can spawn them at markers. */
  spawnMarkers(lootSystem) {
    for (const objective of this.objectives) {
      if (objective.type !== OBJECTIVE_TYPES.RECOVER) continue;
      for (const marker of objective.markers) {
        const drop = lootSystem.spawnDrop({
          kind: 'objective',
          key: 'datashard',
          amount: 1,
          rarity: 'epic',
          x: marker.x,
          y: marker.y,
          radius: 16,
          objectiveId: objective.id,
        });
        marker.dropId = drop.id;
      }
    }
  }

  /**
   * @param {number} dt
   * @param {Object} ctx
   */
  update(dt, ctx) {
    void dt;
    let allComplete = true;
    for (const objective of this.objectives) {
      if (!objective.complete) allComplete = false;
    }
    if (allComplete && !this.allComplete) {
      this.allComplete = true;
      if (this.onAllComplete) this.onAllComplete();
    }
    void ctx;
  }

  _report(objective, ctx) {
    if (this.onProgress) this.onProgress(objective);
    if (objective.progress >= objective.target && !objective.complete) {
      objective.complete = true;
      objective.progress = objective.target;
      objective.completionTime = ctx?.elapsed ?? 0;
      if (ctx && ctx.onObjectiveComplete) ctx.onObjectiveComplete(objective);
      if (this.onComplete) this.onComplete(objective);
      let allDone = true;
      for (const o of this.objectives) if (!o.complete) allDone = false;
      if (allDone) {
        this.allComplete = true;
        if (this.onAllComplete) this.onAllComplete();
      }
    }
  }

  /**
   * Called when an enemy dies.
   *
   * A purge objective counts every hostile; the commander objective counts one
   * specific spawn, matched by its stable generator index so the same enemy is
   * meant before and after a resume.
   */
  onEnemyKilled(enemy = null) {
    let reported = false;
    const hunt = this.objectives.find((o) => o.type === OBJECTIVE_TYPES.HUNT && !o.complete);
    if (hunt && enemy && Number.isInteger(enemy.spawnIndex) && enemy.spawnIndex >= 0
      && hunt.targetSpawnIndex === enemy.spawnIndex) {
      this.setProgress(hunt, hunt.progress + 1);
      reported = true;
    }
    const objective = this.objectives.find((o) => o.type === OBJECTIVE_TYPES.ELIMINATE && !o.complete);
    if (!objective) return reported;
    this.setProgress(objective, objective.progress + 1);
    return true;
  }

  /** Called when the boss dies. */
  onBossKilled() {
    const objective = this.objectives.find((o) => o.type === OBJECTIVE_TYPES.BOSS && !o.complete);
    if (!objective) return false;
    this.setProgress(objective, objective.target);
    return true;
  }

  /**
   * Called when a data shard drop with `objectiveId` is collected.
   * @param {string} objectiveId
   * @param {string|number} markerRef either a marker's stable id or the id of
   *   the loot drop that was spawned for it.
   */
  onMarkerCollected(objectiveId, markerRef) {
    const objective = this.objectives.find((o) => o.id === objectiveId);
    if (!objective) return false;
    const marker = objective.markers.find((m) => m.id === markerRef || (m.dropId !== null && m.dropId === markerRef));
    if (!marker || marker.collected) return false;
    marker.collected = true;
    this.setProgress(objective, objective.progress + 1);
    return true;
  }

  /** Called when a reactor prop is destroyed. */
  onPropDestroyed(objectiveId) {
    const objective = this.objectives.find((o) => o.id === objectiveId);
    if (!objective) return false;
    this.setProgress(objective, objective.progress + 1);
    return true;
  }

  setProgress(objective, value) {
    const next = Math.max(objective.progress, Math.min(objective.target, value));
    if (next === objective.progress) return;
    objective.progress = next;
    this._report(objective, null);
  }

  /** Forces a progress report after external state changes (e.g. prop destruction). */
  refresh(ctx) {
    for (const objective of this.objectives) {
      if (!objective.complete && objective.progress >= objective.target) {
        this._report(objective, ctx);
      }
    }
  }

  /** HUD text: "SABOTAGE REACTORS  1/2". */
  describe(objective) {
    if (!objective) return { title: 'NO ACTIVE OBJECTIVE', detail: '', ratio: 1 };
    const ratio = Math.min(1, objective.progress / objective.target);
    let detail = objective.description;
    if (objective.type === OBJECTIVE_TYPES.ELIMINATE) {
      detail = `Hostiles purged: ${objective.progress} / ${objective.target}`;
    } else if (objective.type === OBJECTIVE_TYPES.HUNT) {
      detail = objective.progress >= objective.target
        ? 'Commander eliminated'
        : 'Commander still active — locate and eliminate';
    } else if (objective.type === OBJECTIVE_TYPES.RECOVER) {
      detail = `Data shards recovered: ${objective.progress} / ${objective.target}`;
    } else if (objective.type === OBJECTIVE_TYPES.DESTROY) {
      detail = `Reactors destroyed: ${objective.progress} / ${objective.target}`;
    } else if (objective.type === OBJECTIVE_TYPES.BOSS) {
      detail = 'Eliminate the Foundry Overseer';
    }
    return { title: objective.title, detail, ratio, complete: objective.complete };
  }

  /** Objective markers that should still be drawn on the map/minimap. */
  activeMarkers() {
    const out = [];
    for (const objective of this.objectives) {
      if (objective.complete) continue;
      if (objective.type === OBJECTIVE_TYPES.DESTROY || objective.type === OBJECTIVE_TYPES.RECOVER) {
        for (const marker of objective.markers) {
          if (marker.collected) continue;
          out.push({ x: marker.x, y: marker.y, objectiveId: objective.id, type: objective.type });
        }
      } else {
        // The commander marker follows the target itself, so the HUD arrow and
        // the minimap point at the enemy and not at the room it was assigned.
        const at = objective.type === OBJECTIVE_TYPES.HUNT && objective.targetPosition
          ? objective.targetPosition
          : objective.position;
        out.push({ x: at.x, y: at.y, objectiveId: objective.id, type: objective.type });
      }
    }
    return out;
  }

  /** Distance from a point to the closest incomplete objective marker. */
  nearestMarkerDistance(x, y) {
    let best = Infinity;
    for (const marker of this.activeMarkers()) {
      const d = dist2(x, y, marker.x, marker.y);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  serialize() {
    return {
      objectives: this.objectives.map((o) => ({ id: o.id, progress: o.progress, complete: o.complete })),
    };
  }

  /**
   * @param {{objectives?: Array<{id:string,progress:number,complete:boolean}>, tier?:number}} data
   * @param {number|null} [tier] sector the state is being restored into
   * @returns {boolean} whether the state was applied
   */
  restore(data, tier = null) {
    if (!data || !Array.isArray(data.objectives)) return false;
    // Objective ids ('objective-main') are reused by every tier, so a state
    // that names another sector must never be applied here: matching by id
    // alone would transplant progress onto unrelated content, and a completed
    // foreign objective would open this sector's extraction gate. A state
    // without a tier predates the scoping and stays accepted (legacy saves).
    if (Number.isFinite(data.tier) && data.tier !== tier) return false;
    for (const saved of data.objectives) {
      const objective = this.objectives.find((o) => o.id === saved.id);
      if (!objective) continue;
      objective.progress = Math.max(0, Math.min(objective.target, Math.round(saved.progress ?? 0)));
      objective.complete = Boolean(saved.complete) || objective.progress >= objective.target;
    }
    this.allComplete = this.objectives.every((o) => o.complete);
    return true;
  }
}
