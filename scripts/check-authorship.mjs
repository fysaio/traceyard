// A change belongs to the people who push it. Fails when commits or the pull
// request description credit anything else.
import { execFileSync } from "node:child_process";

const { BASE_SHA, HEAD_SHA, PR_BODY = "" } = process.env;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });

// Co-authors must already have authored a commit on the base branch.
const people = new Set(
  git("log", "--format=%ae", BASE_SHA).toLowerCase().split("\n").filter(Boolean),
);
const automated = (email) =>
  !/dependabot\[bot\]/i.test(email) && /^noreply@|\[bot\]@|(agent|bot)@/i.test(email);
const footer =
  /^[\W_]*(<sub>)?[\W_]*(created|generated|made|written|built) (with|by|using) (\[|.*https?:\/\/)/im;
const session = /^[a-z-]*session(-url)?:\s*https?:/im;

const problems = [];
const inspect = (where, text) => {
  if (footer.test(text)) problems.push(`${where}: tool credit footer`);
  if (session.test(text)) problems.push(`${where}: session link`);
  for (const [, email] of text.matchAll(/^co-authored-by:.*<([^>]+)>/gim))
    if (!people.has(email.toLowerCase())) problems.push(`${where}: co-author <${email}>`);
};

for (const sha of git("rev-list", `${BASE_SHA}..${HEAD_SHA}`).split("\n").filter(Boolean)) {
  const [author, committer, message] = git("log", "-1", "--format=%ae%x00%ce%x00%B", sha).split(
    "\0",
  );
  const where = `commit ${sha.slice(0, 8)}`;
  if (automated(author)) problems.push(`${where}: author <${author}>`);
  if (committer !== "noreply@github.com" && automated(committer))
    problems.push(`${where}: committer <${committer}>`);
  inspect(where, message);
}
inspect("pull request description", PR_BODY.replace(/\r/g, ""));

if (problems.length) {
  console.error(`Fix these before merging (see AGENTS.md):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("Authorship check passed.");
