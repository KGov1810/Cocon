// Vue « setupviewv2 » d'un logement Takao Plus multi-split (hub + 2 pièces),
// reconstruite d'après un rapport de diagnostic réel. Identifiants et valeurs
// d'identification remplacés ; seules les capacités utiles aux tests sont gardées.

const cap = (capabilityId, value) => ({ capabilityId, value });

/** Capacités d'une pièce climatisée ; `overrides` remplace des valeurs. */
export function roomCapabilities(overrides = {}) {
  const base = {
    7: "4", // mode : chaud
    40: "26", // consigne chaud
    117: "22.25", // température mesurée
    154: "Chambre", // nom de la pièce
    157: "0", // dérogation au programme
    160: "16.0000000000000000000",
    161: "30.0000000000000000000",
    162: "18.0000000000000000000",
    163: "30.0000000000000000000",
    166: "411", // modes : arrêt, auto, froid, chaud, ventilation, déshumidification
    177: "26.00000000000000000000", // consigne froid
    184: "0", // BASIC (programme inactif)
    294: "0.5000000000000000000", // pas de consigne
    100505: "0", // pleine puissance
    100507: "1", // économie d'énergie
    100800: "2", // vitesses : basse, moyenne, haute, auto
    100801: "5", // vitesse : auto
    100802: "0", // silence
    100803: "4", // volets : position 4
    100804: "0", // balayage
    103150: "1", // température valide
  };
  return Object.entries({ ...base, ...overrides }).map(([id, value]) => cap(Number(id), value));
}

export function makeSetup({ chambre = {}, salon = {}, salonAvailable = true } = {}) {
  return {
    id: 900001,
    name: "setup1",
    rateLimit: 30,
    zones: [
      { id: 10, name: "zoneTechnique" },
      { id: 11, name: "Chambre" },
      { id: 12, name: "Salon" },
    ],
    devices: [
      {
        deviceId: 1000,
        name: "HUB Cozytouch",
        modelId: 1457,
        zoneId: 10,
        isAvailable: true,
        capabilities: [cap(152, "0"), cap(172, "10")],
      },
      {
        deviceId: 1001,
        name: "ROOM_0",
        modelId: 557,
        zoneId: 11,
        isAvailable: true,
        capabilities: roomCapabilities(chambre),
      },
      {
        deviceId: 1002,
        name: "THZONE_0",
        modelId: 1505,
        zoneId: 11,
        isAvailable: true,
        capabilities: [cap(100014, "2"), cap(100044, "[1,2,3,4,5,6,7,8]")],
      },
      {
        deviceId: 1003,
        name: "ROOM_1",
        modelId: 558,
        zoneId: 12,
        isAvailable: salonAvailable,
        capabilities: roomCapabilities({
          7: "0",
          40: "25",
          117: "-50.01",
          154: "Salon",
          177: "25",
          100803: "1",
          ...salon,
        }),
      },
    ],
  };
}
