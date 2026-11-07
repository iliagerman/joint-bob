// Every film this folder can render, by name. A film says how long it is, which recording
// frame each screen shows at each frame, what it sounds like, and how to draw itself.
//
//   monday       the main film: one developer's day, drawn on paper, about a minute and a half
//   short        the same day in thirty seconds, for posting and the top of the landing page
//   the rest     one feature each, described in films/
//
// The films are timed by their narration (`beats` in feature.js), and play at the pace they are written.
import analytics from "./films/analytics.js";
import agentBrowser from "./films/browser.js";
import alerts from "./films/alerts.js";
import assistant from "./films/assistant.js";
import budgets from "./films/budgets.js";
import control from "./films/control.js";
import dashboards from "./films/dashboards.js";
import guardian from "./films/guardian.js";
import lid from "./films/lid.js";
import monday from "./films/monday.js";
import pocket from "./films/pocket.js";
import pools from "./films/pools.js";
import schedule from "./films/schedule.js";
import secrets from "./films/secrets.js";
import short from "./films/short.js";
import story from "./films/story.js";
import team from "./films/team.js";

export const films = Object.fromEntries([monday, short, lid, team, pools, budgets, guardian, control, dashboards, assistant, pocket, story, schedule, alerts, agentBrowser, secrets, analytics].map((film) => [film.id, film]));
