# Cobalt pilot reporting policy

Revision 2026-10-09. Synthetic test material, not an OCPP requirement.

A heartbeat stale interval begins after three missed scheduled heartbeats. Until corroborating status or delivery evidence arrives, classify that interval as unknown, not confirmed downtime. Report communications availability separately from charging capability. Use the port as the reporting unit. Eligible minutes exclude only operator-approved scheduled maintenance. Publish unknown minutes separately and include them as not-proven-up minutes in the conservative uptime numerator.
