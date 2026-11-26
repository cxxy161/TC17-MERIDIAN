(function (global) {
  "use strict";

  // 1. 全局常量与返回码
  const CONSTANTS = {
    OK: 0,
    ERR_NOT_OWNER: -1,
    ERR_NO_PATH: -2,
    ERR_BUSY: -4,
    ERR_NOT_FOUND: -5,
    ERR_NOT_ENOUGH_RESOURCES: -6,
    ERR_INVALID_TARGET: -7,
    ERR_FULL: -8,
    ERR_NOT_IN_RANGE: -9,
    ERR_INVALID_ARGS: -10,
    ERR_NOT_ENOUGH_CREDITS: -14,
    ORDER_BUY: "buy",
    ORDER_SELL: "sell",
    MONEY_SCALE: 10000,
  };
  for (const [k, v] of Object.entries(CONSTANTS)) {
    Object.defineProperty(global, k, { value: v, enumerable: true, writable: false });
  }

  let resourcesInited = false;
  let RESOURCES_LIST = Object.freeze([]);
  let RESOURCE_SET = new Set();
  function ensureResources(list) {
    if (resourcesInited) return;
    resourcesInited = true;
    RESOURCES_LIST = Object.freeze((list || []).slice());
    RESOURCE_SET = new Set(RESOURCES_LIST);
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
  }

  // Deterministic per-tick PRNG so Math.random() stays replay-reproducible inside the sandbox
  let rngState = 0x9e3779b9;
  function reseedRng(seed) {
    rngState = (Number(seed) >>> 0) || 0x9e3779b9;
  }
  Math.random = function () {
    let t = (rngState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

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

  function emitLog(level, args) {
    const parts = [];
    for (let i = 0; i < args.length; i++) parts.push(formatArg(args[i]));
    global.__meridian_log(level, parts.join(" "));
  }

  Object.defineProperty(global, "console", {
    value: Object.freeze({
      log: function () { emitLog("log", arguments); },
      warn: function () { emitLog("warn", arguments); },
      error: function () { emitLog("error", arguments); },
    }),
    enumerable: true,
    writable: false,
  });

  // 3. CommonJS require(name) with folder normalization & circular guard
  const moduleCache = Object.create(null);
  function normalizeMod(name) {
    let s = String(name || "").trim();
    if (s.startsWith("./")) s = s.slice(2);
    if (s.endsWith(".js")) s = s.slice(0, -3);
    return s;
  }

  function requireFn(name) {
    const key = normalizeMod(name);
    if (!key) throw new Error("Module name cannot be empty");
    if (moduleCache[key]) return moduleCache[key].exports;
    const src = global.__meridian_get_module(key);
    if (src === null || src === undefined) {
      throw new Error("Cannot find module '" + name + "'");
    }
    const mod = { exports: {} };
    moduleCache[key] = mod;
    try {
      const fn = new Function("exports", "require", "module", src);
      fn(mod.exports, requireFn, mod);
    } catch (err) {
      delete moduleCache[key];
      throw err;
    }
    return mod.exports;
  }
  Object.defineProperty(global, "require", {
    value: requireFn,
    enumerable: true,
    writable: false,
  });

  // 4. Screeps-style Store container
  function createStore(rawCounts, capacity) {
    const base = Object.create(null);
    if (rawCounts) {
      for (const [k, v] of Object.entries(rawCounts)) {
        if (v > 0) base[k] = v;
      }
    }
    const cap = capacity === null || capacity === undefined ? null : capacity;

    function getUsedCapacity(res) {
      if (res !== undefined && res !== null) {
        if (!RESOURCE_SET.has(res)) return 0;
        return base[res] || 0;
      }
      let sum = 0;
      for (const k of Object.keys(base)) sum += base[k];
      return sum;
    }

    function getCapacity(_res) {
      return cap;
    }

    function getFreeCapacity(res) {
      if (cap === null) return null;
      return Math.max(0, cap - getUsedCapacity(res));
    }

    const storeMethods = { getUsedCapacity, getCapacity, getFreeCapacity };
    const proxy = new Proxy(base, {
      get(target, prop) {
        if (prop === "getUsedCapacity") return storeMethods.getUsedCapacity;
        if (prop === "getCapacity") return storeMethods.getCapacity;
        if (prop === "getFreeCapacity") return storeMethods.getFreeCapacity;
        if (prop === "toJSON") {
          return function () {
            const out = {};
            for (const k of Object.keys(target)) out[k] = target[k];
            return out;
          };
        }
        if (typeof prop === "symbol") return undefined;
        if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
        if (RESOURCE_SET.has(prop)) return 0;
        return undefined;
      },
      set() { return false; },
      deleteProperty() { return false; },
    });
    return Object.freeze(proxy);
  }

  // 5. Frozen static Catalog (loaded once per VM creation)
  let frozenCatalog = null;
  function ensureCatalog() {
    if (frozenCatalog !== null) return frozenCatalog;
    const rawJson = global.__meridian_get_catalog();
    const raw = rawJson ? JSON.parse(rawJson) : { items: {}, buildings: {}, recipes: {}, recipesByBuilding: {} };
    for (const k of Object.keys(raw.items || {})) Object.freeze(raw.items[k]);
    Object.freeze(raw.items || {});
    for (const k of Object.keys(raw.buildings || {})) {
      const b = raw.buildings[k];
      if (Array.isArray(b.buildCost)) {
        for (const c of b.buildCost) Object.freeze(c);
        Object.freeze(b.buildCost);
      }
      Object.freeze(b);
    }
    Object.freeze(raw.buildings || {});
    for (const k of Object.keys(raw.recipes || {})) {
      const r = raw.recipes[k];
      if (Array.isArray(r.inputs)) {
        for (const c of r.inputs) Object.freeze(c);
        Object.freeze(r.inputs);
      }
      if (Array.isArray(r.outputs)) {
        for (const c of r.outputs) Object.freeze(c);
        Object.freeze(r.outputs);
      }
      Object.freeze(r);
    }
    Object.freeze(raw.recipes || {});
    for (const k of Object.keys(raw.recipesByBuilding || {})) {
      Object.freeze(raw.recipesByBuilding[k]);
    }
    Object.freeze(raw.recipesByBuilding || {});
    frozenCatalog = Object.freeze(raw);
    return frozenCatalog;
  }

  // 6. Per-domain APIs (Game.map, Game.market, Game.bank)
  const EMPTY_FROZEN_MAP = Object.freeze(Object.create(null));
  const EMPTY_FROZEN_ARRAY = Object.freeze([]);
  let currentOrders = EMPTY_FROZEN_MAP;
  let currentTransactions = EMPTY_FROZEN_ARRAY;
  let currentHomePlanetId = "";

  const mapApi = Object.freeze({
    calcRoute(fromId, toId) {
      if (typeof fromId !== "string" || typeof toId !== "string") return null;
      const json = global.__meridian_calc_route(fromId, toId);
      return json ? JSON.parse(json) : null;
    },

    getLandPlots(planetId) {
      if (typeof planetId !== "string" || !planetId) return null;
      const json = global.__meridian_get_land_plots(planetId);
      return json ? JSON.parse(json) : null;
    },

    buyPlot(planetId, slotId) {
      if (typeof planetId !== "string" || !planetId) return CONSTANTS.ERR_INVALID_ARGS;
      if (slotId === undefined || slotId === null || (typeof slotId !== "string" && typeof slotId !== "number")) {
        return CONSTANTS.ERR_INVALID_ARGS;
      }
      return global.__meridian_buy_plot(planetId, "slot", String(slotId));
    },

    listCompanies(filter) {
      let query = "";
      let planetId = "";
      let onlyPlayers = false;
      let offset = 0;
      let limit = 100;
      if (filter && typeof filter === "object") {
        if (typeof filter.query === "string") query = filter.query;
        if (typeof filter.planetId === "string") planetId = filter.planetId;
        if (filter.onlyPlayers === true) onlyPlayers = true;
        if (typeof filter.offset === "number" && Number.isFinite(filter.offset) && filter.offset >= 0) {
          offset = Math.floor(filter.offset);
        }
        if (typeof filter.limit === "number" && Number.isFinite(filter.limit) && filter.limit > 0) {
          limit = Math.min(1000, Math.floor(filter.limit));
        }
      }
      const json = global.__meridian_list_companies(query, planetId, onlyPlayers, offset, limit);
      return json ? JSON.parse(json) : [];
    },

    getCompany(companyId) {
      if (typeof companyId !== "string" || !companyId) return null;
      const json = global.__meridian_get_company(companyId);
      return json ? JSON.parse(json) : null;
    },
  });

  const marketApi = Object.freeze({
    get orders() {
      return currentOrders;
    },
    get transactions() {
      return currentTransactions;
    },

    quote(stationId, resourceType) {
      if (typeof stationId !== "string" || typeof resourceType !== "string") return null;
      const json = global.__meridian_quote(stationId, resourceType);
      return json ? JSON.parse(json) : null;
    },

    depth(stationId, resourceType, limit) {
      if (typeof stationId !== "string" || typeof resourceType !== "string") {
        return { bids: [], asks: [] };
      }
      const lim = typeof limit === "number" && limit > 0 ? Math.min(5, Math.floor(limit)) : 5;
      const json = global.__meridian_depth(stationId, resourceType, lim);
      return json ? JSON.parse(json) : { bids: [], asks: [] };
    },

    getAllOrders(filter) {
      let sid = "";
      let res = "";
      let side = "";
      let offset = 0;
      let limit = 200;
      if (filter && typeof filter === "object") {
        if (typeof filter.stationId === "string") sid = filter.stationId;
        if (typeof filter.resourceType === "string") res = filter.resourceType;
        if (typeof filter.type === "string") side = filter.type;
        if (typeof filter.offset === "number" && Number.isFinite(filter.offset) && filter.offset >= 0) {
          offset = Math.floor(filter.offset);
        }
        if (typeof filter.limit === "number" && Number.isFinite(filter.limit) && filter.limit > 0) {
          limit = Math.min(1000, Math.floor(filter.limit));
        }
      }
      const json = global.__meridian_get_all_orders(sid, res, side, offset, limit);
      return json ? JSON.parse(json) : [];
    },

    getOrderById(orderId) {
      if (orderId === undefined || orderId === null) return null;
      const idStr = String(orderId).trim();
      if (!idStr) return null;
      const json = global.__meridian_get_order_by_id(idStr);
      return json ? JSON.parse(json) : null;
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

    buyLand(listingId) {
      if (listingId === undefined || listingId === null || (typeof listingId !== "string" && typeof listingId !== "number")) {
        return CONSTANTS.ERR_INVALID_ARGS;
      }
      return global.__meridian_buy_plot("", "listing", String(listingId));
    },
  });

  function callBank(op, amount, planetId) {
    const pid = planetId === undefined || planetId === null ? currentHomePlanetId : planetId;
    const amt = Number(amount);
    if (typeof pid !== "string" || !pid || !Number.isFinite(amt) || amt <= 0) {
      return CONSTANTS.ERR_INVALID_ARGS;
    }
    return global.__meridian_bank(pid, op, amt);
  }

  const bankApi = Object.freeze({
    deposit(amount, planetId) { return callBank("deposit", amount, planetId); },
    withdraw(amount, planetId) { return callBank("withdraw", amount, planetId); },
    borrow(amount, planetId) { return callBank("borrow", amount, planetId); },
    repay(amount, planetId) { return callBank("repay", amount, planetId); },
  });

  global.__sandbox_refresh_game = function (boot) {
    ensureResources(boot.resources);
    const catalog = ensureCatalog();
    reseedRng((boot.tick + 1) * 2654435761);
    currentHomePlanetId = boot.company.homePlanetId || "";

    // Build stations map first (all world stations) so planets can share exact store/station references
    const stationsMap = Object.create(null);
    const stationStoreBySid = Object.create(null);
    for (const st of boot.stations || []) {
      const storeProxy = createStore(st.store, null);
      stationStoreBySid[st.id] = storeProxy;
      stationsMap[st.id] = Object.freeze({
        id: st.id,
        systemId: st.systemId,
        planetId: st.planetId === undefined ? null : st.planetId,
        store: storeProxy,
      });
    }

    const planetsMap = Object.create(null);
    const planetsBySystem = Object.create(null);
    for (const p of boot.planets) {
      const demandsObj = Object.create(null);
      for (const [itemId, wantQty] of Object.entries(p.demands || {})) {
        demandsObj[itemId] = Object.freeze({ qty: wantQty });
      }
      let cachedListings = null;
      const planetId = p.id;
      const sid = p.stationId || ("ST:" + planetId);
      const stStore = stationStoreBySid[sid] || createStore(p.stationStore, null);
      const planetObj = {
        id: planetId,
        systemId: p.systemId,
        stationId: sid,
        name: p.name,
        wealthTier: p.wealthTier,
        prosperity: p.prosperity,
        population: p.population,
        gravity: p.gravity,
        habitability: p.habitability,
        wasteBacklog: p.wasteBacklog,
        primaryLandPrice: p.primaryLandPrice,
        bankRatePct: p.bankRatePct,
        groundStore: createStore(p.groundStore, null),
        stationStore: stStore,
        demands: Object.freeze(demandsObj),
      };
      Object.defineProperty(planetObj, "landListings", {
        enumerable: true,
        configurable: false,
        get() {
          if (cachedListings === null) {
            const json = global.__sandbox_land_listings(planetId);
            const arr = json ? JSON.parse(json) : [];
            for (const l of arr) Object.freeze(l);
            cachedListings = Object.freeze(arr);
          }
          return cachedListings;
        },
      });
      const frozenPlanet = Object.freeze(planetObj);
      planetsMap[planetId] = frozenPlanet;
      if (!planetsBySystem[p.systemId]) planetsBySystem[p.systemId] = [];
      planetsBySystem[p.systemId].push(planetId);
    }

    const systemsMap = Object.create(null);
    for (const sys of boot.systems || []) {
      systemsMap[sys.id] = Object.freeze({
        id: sys.id,
        name: sys.name,
        starClass: sys.starClass,
        luminosity: sys.luminosity,
        x: sys.x,
        y: sys.y,
        hubStationId: sys.hubStationId,
        planetIds: Object.freeze((planetsBySystem[sys.id] || []).slice()),
      });
    }

    const buildingsMap = Object.create(null);
    const buildingsByPlot = Object.create(null);
    for (const b of boot.buildings) {
      const bObj = Object.freeze({
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
        demolish() {
          return global.__meridian_demolish_facility(b.plotId, b.id);
        },
      });
      buildingsMap[b.id] = bObj;
      if (!buildingsByPlot[b.plotId]) buildingsByPlot[b.plotId] = [];
      buildingsByPlot[b.plotId].push(bObj);
    }

    const sitesMap = Object.create(null);
    const sitesByPlot = Object.create(null);
    for (const st of boot.sites || []) {
      const siteObj = Object.freeze({
        id: st.id,
        plotId: st.plotId,
        planetId: st.planetId,
        buildingType: st.buildingType,
        finishTick: st.finishTick,
        ticksRemaining: st.ticksRemaining,
      });
      sitesMap[st.id] = siteObj;
      if (!sitesByPlot[st.plotId]) sitesByPlot[st.plotId] = [];
      sitesByPlot[st.plotId].push(siteObj);
    }

    const plotsMap = Object.create(null);
    for (const pl of boot.plots) {
      const mods = Object.freeze(Object.assign(Object.create(null), pl.buildingMods || {}));
      plotsMap[pl.id] = Object.freeze({
        id: pl.id,
        slotId: pl.slotId,
        planetId: pl.planetId,
        lat: pl.lat,
        lon: pl.lon,
        terrainName: pl.terrainName,
        capacity: pl.capacity,
        usedSlots: pl.usedSlots,
        buildingMods: mods,
        buildings: Object.freeze(buildingsByPlot[pl.id] || []),
        sites: Object.freeze(sitesByPlot[pl.id] || []),
        build(buildingType) {
          if (typeof buildingType !== "string" || !buildingType) return CONSTANTS.ERR_INVALID_ARGS;
          return global.__meridian_build_facility(pl.id, buildingType);
        },
      });
    }

    const shipsMap = Object.create(null);
    for (const s of boot.ships) {
      shipsMap[s.id] = Object.freeze({
        id: s.id,
        size: s.size,
        capacity: s.capacity,
        durability: s.durability,
        location: s.location,
        busyUntil: s.busyUntil,
        isBusy: s.isBusy,
        store: createStore(s.cargo, s.capacity),
        dispatch(to, cargo) {
          if (typeof to !== "string" || !to) {
            return CONSTANTS.ERR_INVALID_ARGS;
          }
          const cleanCargo = cargo === undefined || cargo === null ? {} : cargo;
          if (typeof cleanCargo !== "object" || Array.isArray(cleanCargo)) {
            return CONSTANTS.ERR_INVALID_ARGS;
          }
          return global.__meridian_dispatch_ship(s.id, to, JSON.stringify(cleanCargo));
        },
        repair() {
          return global.__meridian_repair_ship(s.id);
        },
      });
    }

    const ownOrdersMap = Object.create(null);
    for (const o of boot.ownOrders || []) {
      ownOrdersMap[o.id] = Object.freeze(o);
    }
    currentOrders = Object.freeze(ownOrdersMap);

    const lt = boot.lastTick || { fills: [], rejected: [] };
    const ltFills = Object.freeze((lt.fills || []).map((f) => Object.freeze(f)));
    const ltRej = Object.freeze((lt.rejected || []).map((r) => Object.freeze(r)));
    currentTransactions = ltFills;

    const lastTickObj = Object.freeze({
      fills: ltFills,
      rejected: ltRej,
    });

    const frozenSystems = Object.freeze(systemsMap);
    const frozenPlanets = Object.freeze(planetsMap);
    const frozenStations = Object.freeze(stationsMap);
    const frozenPlots = Object.freeze(plotsMap);
    const frozenBuildings = Object.freeze(buildingsMap);
    const frozenSites = Object.freeze(sitesMap);
    const frozenShips = Object.freeze(shipsMap);

    function getObjectByIdFn(id) {
      if (id === undefined || id === null) return null;
      const key = String(id);
      return (
        frozenBuildings[key] ||
        frozenPlots[key] ||
        frozenSites[key] ||
        frozenShips[key] ||
        frozenPlanets[key] ||
        frozenStations[key] ||
        frozenSystems[key] ||
        null
      );
    }

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
      systems: frozenSystems,
      planets: frozenPlanets,
      stations: frozenStations,
      plots: frozenPlots,
      buildings: frozenBuildings,
      sites: frozenSites,
      ships: frozenShips,
      catalog: catalog,
      lastTick: lastTickObj,
      map: mapApi,
      market: marketApi,
      bank: bankApi,
      getObjectById: getObjectByIdFn,
    });
  };

  // 7. Execute user's module.exports.loop() and serialize Memory
  global.__meridian_run_tick = function () {
    const mainMod = requireFn("main");
    if (!mainMod || typeof mainMod.loop !== "function") {
      throw new Error("Module 'main' must export a loop function: module.exports.loop = function() { ... }");
    }
    mainMod.loop();
    return JSON.stringify(global.Memory === undefined ? {} : global.Memory);
  };

  // 8. Console REPL evaluation inside the real sandbox
  function toSafeJsonValue(val, depth) {
    if (val === undefined) return { kind: "undefined" };
    if (val === null) return { kind: "null", value: null };
    if (typeof val === "boolean" || typeof val === "string") return { kind: typeof val, value: val };
    if (typeof val === "number") {
      return Number.isFinite(val) ? { kind: "number", value: val } : { kind: "string", value: String(val) };
    }
    if (typeof val === "function") return { kind: "function", value: "[Function]" };
    if (depth > 4) return { kind: "truncated", value: "..." };
    try {
      if (typeof val.toJSON === "function") {
        val = val.toJSON();
      }
      if (Array.isArray(val)) {
        const out = [];
        const lim = Math.min(val.length, 50);
        for (let i = 0; i < lim; i++) out.push(val[i]);
        return { kind: "json", value: JSON.parse(JSON.stringify(out)) };
      }
      return { kind: "json", value: JSON.parse(JSON.stringify(val)) };
    } catch (_e) {
      return { kind: "string", value: String(val) };
    }
  }

  global.__meridian_eval_console = function (code) {
    let resVal;
    try {
      const fn = new Function("return (" + code + ");");
      resVal = fn();
    } catch (exprErr) {
      if (exprErr instanceof SyntaxError) {
        resVal = (0, eval)(code);
      } else {
        throw exprErr;
      }
    }
    const memJson = JSON.stringify(global.Memory === undefined ? {} : global.Memory);
    return JSON.stringify({
      result: toSafeJsonValue(resVal, 0),
      memoryJson: memJson,
    });
  };
})(globalThis);
