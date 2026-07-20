# CrewPoppy

*Mission Control for your AI crew.* A fleet of task-specific AI agents that run **entirely in your
own AWS account** — an [AgentsPoppy](https://agentspoppy.com) poppy.

- **Your agents, your cloud.** Prompts, memory, outputs, logs, and token spend all live in your own
  AWS (via Amazon Bedrock). No agent-platform vendor ever sees your data or what your agents do.
- **Give an agent a job, not a training set.** A name, a role ("Social Media Manager"), and
  instructions — the model already knows *how*; you brief, test, and supervise. Optional
  AI-generated face so your crew feels like a team.
- **You stay in control.** Agents ask before doing anything consequential ("approve this reply?"),
  answered from your desktop or your phone. Nothing publishes or sends without your say-so until you
  trust it.
- **A runaway agent can't surprise you.** Per-run and per-agent hard spend caps, a kill switch, and
  a live cost meter — inference is a line on *your* AWS bill, capped by *you*.
- **Zero lock-in.** Your agents are just data you own — export the whole crew and re-import it
  anywhere. Nothing trapped in a vendor.

**Status: in development** (design complete — see [`DESIGN.md`](DESIGN.md) for the architecture, the
recursive-broker safety model, and the roadmap). Free core; one optional premium ("CrewPoppy
Mobile": talk to your crew and approve their work from your phone) sold through AgentsPoppy's in-app
checkout.

## License

MIT — see [LICENSE](LICENSE).
