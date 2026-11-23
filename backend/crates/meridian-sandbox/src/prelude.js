(function (global) {
  "use strict";

  // 1. Screeps-compatible constants
  const CONSTANTS = {
    OK: 0,
    ERR_NOT_OWNER: -1,
    ERR_NO_PATH: -2,
    ERR_NAME_EXISTS: -3,
    ERR_BUSY: -4,
    ERR_NOT_FOUND: -5,
    ERR_NOT_ENOUGH_RESOURCES: -6,
    ERR_INVALID_TARGET: -7,
    ERR_FULL: -8,
    ERR_NOT_IN_RANGE: -9,
    ERR_INVALID_ARGS: -10,
    ERR_TIRED: -11,
    ERR_NOT_ENOUGH_CREDITS: -14,
    ORDER_BUY: "buy",
    ORDER_SELL: "sell",
  };
  for (const [k, v] of Object.entries(CONSTANTS)) {
    Object.defineProperty(global, k, { value: v, enumerable: true, writable: false });
  }

  const boot = global.__MERIDIAN_BOOTSTRAP;
  delete global.__MERIDIAN_BOOTSTRAP;

  const RESOURCES_LIST = Object.freeze(boot.resources.slice());
  const RESOURCE_SET = new Set(RESOURCES_LIST);
  Object.defineProperty(global, "RESOURCES_ALL", {
    value: RESOURCES_LIST,
    enumerable: true,
    writable: false,
  });
  for (const res of RESOURCES_LIST) {
    const constName = "RESOURCE_" + res.toUpperCase();
    if (!(constName in global)) {
      Object.defineProperty(global, constName, {
        value: res,
        enumerable: true,
        writable: false,
      });
    }
  }

  // 2. Console interception (forwarded to Rust bounded log buffer)
  function formatArg(val) {
    if (val === null) return "null";
    if (val === undefined) return "undefined";
    if (typeof val === "string") return val;
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (val instanceof Error) return val.stack ? String(val.stack) : String(val);
    try {
      return JSON.stringify(val);
    } catch (_e) {
      return String(val);
    }
  }
  function makeLogger(level) {
    return function () {
      const parts = [];
      for (let i = 0; i < arguments.length; i++) {
        parts.push(formatArg(arguments[i]));
      }
      global.__meridian_log(level, parts.join(" "));
    };
  }
  global.console = Object.freeze({
    log: makeLogger("log"),
    warn: makeLogger("warn"),
    error: makeLogger("error"),
  });

  // 3. Store Proxy (Screeps-compatible Store view)
  function createStore(rawMap, totalCapacity) {
    const counts = Object.create(null);
    let totalUsed = 0;
    if (rawMap) {
      for (const [k, v] of Object.entries(rawMap)) {
        const n = Number(v) || 0;
        if (n > 0) {
          counts[k] = n;
          totalUsed += n;
        }
      }
    }

    const api = {
      getCapacity(resource) {
        if (resource !== undefined && !RESOURCE_SET.has(resource)) return null;
        return totalCapacity === undefined || totalCapacity === null ? null : totalCapacity;
      },
      getUsedCapacity(resource) {
        if (resource === undefined) return totalUsed;
        if (!RESOURCE_SET.has(resource)) return null;
        return counts[resource] || 0;
      },
      getFreeCapacity(resource) {
        if (totalCapacity === undefined || totalCapacity === null) return null;
        if (resource !== undefined && !RESOURCE_SET.has(resource)) return null;
        return Math.max(0, totalCapacity - totalUsed);
      },
    };

    const target = Object.assign(Object.create(null), counts, api);
    return new Proxy(target, {
      get(obj, prop) {
        if (typeof prop === "string") {
          if (prop in api) return api[prop];
          if (prop in obj) return obj[prop];
          if (RESOURCE_SET.has(prop)) return 0;
        }
        return undefined;
      },
      set() {
        return false;
      },
      deleteProperty() {
        return false;
      },
      ownKeys() {
        return Object.keys(counts);
      },
      getOwnPropertyDescriptor(obj, prop) {
        if (typeof prop === "string" && prop in counts) {
          return { enumerable: true, configurable: true, value: counts[prop] };
        }
        return Object.getOwnPropertyDescriptor(obj, prop);
      },
    });
  }

  // 4. CommonJS multi-module require()
  const moduleCache = Object.create(null);
  const loadingSet = new Set();

  function normalizeName(name) {
    return String(name || "")
      .trim()
      .replace(/^\.\//, "")
      .replace(/\.js$/, "");
  }

  function requireFn(rawName) {
    const name = normalizeName(rawName);
    if (!name) {
      throw new Error("require(): empty module name");
    }
    if (Object.prototype.hasOwnProperty.call(moduleCache, name)) {
      return moduleCache[name].exports;
    }
    if (loadingSet.has(name)) {
      throw new Error("Circular dependency detected while requiring '" + name + "'");
    }
    const source = global.__meridian_get_module(name);
    if (typeof source !== "string") {
      throw new Error("Cannot find module '" + rawName + "'");
    }
    const mod = { exports: {} };
    loadingSet.add(name);
    try {
      const fn = new Function("exports", "require", "module", "__filename", source);
      fn(mod.exports, requireFn, mod, name + ".js");
      moduleCache[name] = mod;
      return mod.exports;
    } finally {
      loadingSet.delete(name);
    }
  }
  global.require = requireFn;

  // 5. Build Game API objects
  const planetsMap = Object.create(null);
  for (const p of boot.planets) {
    const demandsObj = Object.create(null);
    for (const [itemId, wantQty] of Object.entries(p.demands || {})) {
      demandsObj[itemId] = Object.freeze({ qty: wantQty });
    }
    planetsMap[p.id] = Object.freeze({
      id: p.id,
      name: p.name,
      wealthTier: p.wealthTier,
      prosperity: p.prosperity,
      population: p.population,
      gravity: p.gravity,
      wasteBacklog: p.wasteBacklog,
      primaryLandPrice: p.primaryLandPrice,
      landListings: Object.freeze(p.landListings || []),
      bankRatePct: p.bankRatePct,
      groundStore: createStore(p.groundStore, null),
      stationStore: createStore(p.stationStore, null),
      demands: Object.freeze(demandsObj),
    });
  }

  const stationsMap = Object.create(null);
  for (const [sid, storeObj] of Object.entries(boot.stations || {})) {
    stationsMap[sid] = Object.freeze({
      id: sid,
      store: createStore(storeObj, null),
    });
  }

  const plotsMap = Object.create(null);
  for (const pl of boot.plots) {
    plotsMap[pl.id] = Object.freeze({
      id: pl.id,
      planetId: pl.planetId,
      terrainName: pl.terrainName,
      capacity: pl.capacity,
      usedSlots: pl.usedSlots,
      buildingMods: Object.freeze(pl.buildingMods || {}),
    });
  }

  const buildingsMap = Object.create(null);
  for (const b of boot.buildings) {
    const bObj = {
      id: b.id,
      type: b.type,
      plotId: b.plotId,
      planetId: b.planetId,
      efficiency: b.efficiency,
      recipeId: b.recipeId,
      active: b.active,
      progress: b.progress,
      cycleTicks: b.cycleTicks,
      setRecipe(recipeId) {
        if (typeof recipeId !== "string" || !recipeId) return CONSTANTS.ERR_INVALID_ARGS;
        return global.__meridian_set_recipe(b.id, recipeId);
      },
      setActive(active) {
        if (typeof active !== "boolean") return CONSTANTS.ERR_INVALID_ARGS;
        return global.__meridian_set_active(b.id, active);
      },
    };
    buildingsMap[b.id] = Object.freeze(bObj);
  }

  const shipsMap = Object.create(null);
  for (const s of boot.ships) {
    const sObj = {
      id: s.id,
      size: s.size,
      capacity: s.capacity,
      durability: s.durability,
      location: s.location,
      busyUntil: s.busyUntil,
      isBusy: s.isBusy,
      store: createStore(s.cargo, s.capacity),
      dispatch(from, to, cargo) {
        if (typeof from !== "string" || typeof to !== "string" || !cargo || typeof cargo !== "object") {
          return CONSTANTS.ERR_INVALID_ARGS;
        }
        return global.__meridian_dispatch_ship(s.id, from, to, JSON.stringify(cargo));
      },
      repair() {
        return global.__meridian_repair_ship(s.id);
      },
    };
    shipsMap[s.id] = Object.freeze(sObj);
  }

  const ownOrdersMap = Object.create(null);
  for (const o of boot.ownOrders || []) {
    ownOrdersMap[o.id] = Object.freeze(o);
  }

  const marketApi = Object.freeze({
    credits: boot.company.cash,
    orders: Object.freeze(ownOrdersMap),

    quote(stationId, resourceType) {
      if (typeof stationId !== "string" || typeof resourceType !== "string") return null;
      const json = global.__meridian_quote(stationId, resourceType);
      return json ? JSON.parse(json) : null;
    },

    depth(stationId, resourceType, limit) {
      if (typeof stationId !== "string" || typeof resourceType !== "string") {
        return { bids: [], asks: [] };
      }
      const lim = typeof limit === "number" && limit > 0 ? Math.min(50, Math.floor(limit)) : 10;
      const json = global.__meridian_depth(stationId, resourceType, lim);
      return json ? JSON.parse(json) : { bids: [], asks: [] };
    },

    getAllOrders(filter) {
      let sid = "";
      let res = "";
      let side = "";
      if (filter && typeof filter === "object") {
        if (typeof filter.stationId === "string") sid = filter.stationId;
        if (typeof filter.resourceType === "string") res = filter.resourceType;
        if (typeof filter.type === "string") side = filter.type;
      }
      const json = global.__meridian_get_all_orders(sid, res, side);
      return json ? JSON.parse(json) : [];
    },

    createOrder(params) {
      if (!params || typeof params !== "object") return CONSTANTS.ERR_INVALID_ARGS;
      const side = params.type;
      const res = params.resourceType;
      const price = Number(params.price);
      const amount = Number(params.totalAmount);
      const stationId = params.stationId;
      if (
        (side !== "buy" && side !== "sell") ||
        typeof res !== "string" ||
        typeof stationId !== "string" ||
        !Number.isFinite(price) ||
        price <= 0 ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return CONSTANTS.ERR_INVALID_ARGS;
      }
      return global.__meridian_create_order(stationId, side, res, Math.floor(amount), price);
    },

    cancelOrder(orderId) {
      if (orderId === undefined || orderId === null) return CONSTANTS.ERR_INVALID_ARGS;
      return global.__meridian_cancel_order(String(orderId));
    },

    deal(orderId, amount) {
      const amt = Number(amount);
      if (orderId === undefined || orderId === null || !Number.isFinite(amt) || amt <= 0) {
        return CONSTANTS.ERR_INVALID_ARGS;
      }
      return global.__meridian_deal_order(String(orderId), Math.floor(amt));
    },

    calcRoute(fromId, toId) {
      if (typeof fromId !== "string" || typeof toId !== "string") return null;
      const json = global.__meridian_calc_route(fromId, toId);
      return json ? JSON.parse(json) : null;
    },
  });

  global.Game = Object.freeze({
    time: boot.tick,
    cpi: boot.cpi,
    cpu: Object.freeze({
      limit: boot.cpuLimitMs,
      getUsed() {
        return global.__meridian_cpu_used();
      },
    }),
    company: Object.freeze(boot.company),
    planets: Object.freeze(planetsMap),
    stations: Object.freeze(stationsMap),
    plots: Object.freeze(plotsMap),
    buildings: Object.freeze(buildingsMap),
    ships: Object.freeze(shipsMap),
    market: marketApi,

    buyPlot(planetId, listingId) {
      if (typeof planetId !== "string" || !planetId) return CONSTANTS.ERR_INVALID_ARGS;
      const lid = listingId === undefined || listingId === null ? "" : String(listingId);
      return global.__meridian_buy_plot(planetId, lid);
    },

    buildFacility(plotId, buildingType) {
      if ((typeof plotId !== "string" && typeof plotId !== "number") || typeof buildingType !== "string") {
        return CONSTANTS.ERR_INVALID_ARGS;
      }
      return global.__meridian_build_facility(String(plotId), buildingType);
    },

    demolishFacility(plotId, buildingId) {
      if (
        (typeof plotId !== "string" && typeof plotId !== "number") ||
        (typeof buildingId !== "string" && typeof buildingId !== "number")
      ) {
        return CONSTANTS.ERR_INVALID_ARGS;
      }
      return global.__meridian_demolish_facility(String(plotId), String(buildingId));
    },

    bank(planetId, op, amount) {
      const amt = Number(amount);
      if (
        typeof planetId !== "string" ||
        typeof op !== "string" ||
        !Number.isFinite(amt) ||
        amt <= 0
      ) {
        return CONSTANTS.ERR_INVALID_ARGS;
      }
      return global.__meridian_bank(planetId, op, amt);
    },

    getRecipe(recipeId) {
      if (typeof recipeId !== "string" || !recipeId) return null;
      const json = global.__meridian_get_recipe(recipeId);
      return json ? JSON.parse(json) : null;
    },
  });

  // 6. Execute user's module.exports.loop() and serialize Memory
  global.__meridian_run_tick = function () {
    const mainMod = requireFn("main");
    if (!mainMod || typeof mainMod.loop !== "function") {
      throw new Error("Module 'main' must export a loop function: module.exports.loop = function() { ... }");
    }
    mainMod.loop();
    return JSON.stringify(global.Memory === undefined ? {} : global.Memory);
  };
})(globalThis);
