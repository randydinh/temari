# Verification

This directory contains repository-owned verification capabilities for Temari.

The canonical verifier is [`verify-temari/`](./verify-temari/). It contains the only copy of the instructions, feature map, control CLI, and retained proof. Host-specific discovery files point to it without copying its body.

The packaged [`create-verification-skill`](../skills/create-verification-skill/SKILL.md) and [`maintain-verification-skill`](../skills/maintain-verification-skill/SKILL.md) skills remain generic. They describe how to create and maintain a project verifier. They do not own Temari's app-specific verification steps.
