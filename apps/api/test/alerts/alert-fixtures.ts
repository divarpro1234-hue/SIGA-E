import type { AlertInput } from "../../src/modules/alerts/alert-input.js";

export const identity = { sender: "urn:siga-e:simulacro", identifier: "SIGAE-DEMO-1", sent: "2026-10-21T12:00:00.000Z" };
export const input: AlertInput = {
  kind: "Alert",
  info: {
    scenario: "SISMO", event: "Sismo ficticio", severity: "Severe", urgency: "Immediate",
    certainty: "Likely", headline: "SIMULACRO: sismo ficticio",
    description: "Ejercicio académico ficticio.", expires: "2026-10-21T10:00:00-04:00", areaDesc: "Zona ficticia A",
  },
};
