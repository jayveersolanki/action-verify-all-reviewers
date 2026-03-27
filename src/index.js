const core = require('@actions/core');
const github = require('@actions/github');

// All bot/Copilot variants (always lowercase)
const EXCLUDED_REVIEWERS = [
  "copilot",
  "github-copilot",
  "copilot-pull-request-reviewer[bot]",
  "github-actions[bot]",
  "dependabot[bot]"
];

const main = async () => {
  try {
    const eventName = core.getInput('event_name', { required: true });
    const owner = core.getInput('owner', { required: true });
    const repo = core.getInput('repo', { required: true });
    const token = core.getInput('token', { required: true });
    const pullNumber = core.getInput('pr_number', { required: true });

    const octokit = github.getOctokit(token);

    // Fetch PR details
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber
    });

    // -----------------------------------------------------------
    // 1. PROCESS INDIVIDUAL REVIEWERS
    // -----------------------------------------------------------
    const rawReviewers = pullRequest.requested_reviewers || [];

    const humanReviewers = rawReviewers
      .map(r => r.login.toLowerCase()) // Normalize case
      .filter(login => !EXCLUDED_REVIEWERS.includes(login));

    // -----------------------------------------------------------
    // 2. PROCESS TEAM REVIEWERS (Option B: one member approval)
    // -----------------------------------------------------------
    const rawTeams = pullRequest.requested_teams || [];

    const teamNames = rawTeams
      .map(t => t.slug.toLowerCase())
      .filter(slug => !EXCLUDED_REVIEWERS.includes(slug));

    // Still pending reviewers?
    if (humanReviewers.length > 0 || teamNames.length > 0) {
      const msg = [];

      if (humanReviewers.length > 0)
        msg.push(`${humanReviewers.length} human reviewer(s) left: ${humanReviewers.join(", ")}`);

      if (teamNames.length > 0)
        msg.push(`${teamNames.length} team(s) left: ${teamNames.join(", ")}`);

      core.setFailed(msg.join(" | "));
      return;
    }

    // -----------------------------------------------------------
    // 3. FETCH ALL REVIEW COMMENTS
    // -----------------------------------------------------------
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber
    });

    if (reviews.length === 0) {
      core.setFailed("No reviewers found.");
      return;
    }

    // Store only MOST RECENT review state for each HUMAN reviewer
    const latestStateByUser = {};

    for (const review of reviews) {
      let login = review.user.login.toLowerCase();

      // Exclude bots entirely
      if (EXCLUDED_REVIEWERS.includes(login)) continue;

      latestStateByUser[login] = review.state; // APPROVED / COMMENTED / CHANGES_REQUESTED
    }

    // -----------------------------------------------------------
    // 4. EVALUATE WHO APPROVED VS DID NOT APPROVE
    // -----------------------------------------------------------
    const approvedUsers = [];
    const missingApprovals = [];

    for (const [login, state] of Object.entries(latestStateByUser)) {
      if (state === "APPROVED") {
        approvedUsers.push(login);
      } else {
        // COMMENTED / REQUEST_CHANGES => failure
        missingApprovals.push(`${login} (${state})`);
      }
    }

    // -----------------------------------------------------------
    // 5. TEAM REVIEW LOGIC (Option B)
    // -----------------------------------------------------------
    if (pullRequest.requested_teams && pullRequest.requested_teams.length > 0) {
      for (const team of pullRequest.requested_teams) {

        const teamSlug = team.slug.toLowerCase();

        if (EXCLUDED_REVIEWERS.includes(teamSlug)) continue;

        // Fetch team members
        const { data: teamMembers } = await octokit.rest.teams.listMembersInOrg({
          org: owner,
          team_slug: team.slug
        });

        const teamMemberLogins = teamMembers.map(m => m.login.toLowerCase());

        // Check if any team member approved
        const anyApproved = teamMemberLogins.some(m => approvedUsers.includes(m));

        if (!anyApproved) {
          missingApprovals.push(`Team ${team.slug} (no member approved)`);
        }
      }
    }

    // -----------------------------------------------------------
    // 6. FINAL VALIDATION
    // -----------------------------------------------------------
    if (missingApprovals.length > 0) {
      core.setFailed(
        `All reviewers must approve. Missing approvals: ${missingApprovals.join(", ")}`
      );
      return;
    }

    if (approvedUsers.length === 0) {
      core.setFailed("No approvals found from human reviewers.");
      return;
    }

    core.info(`Current Approver(s): ${approvedUsers.join(", ")}`);

    // -------------------------------------------------------------------
    // 7. EXISTING RE-RUN LOGIC (UNCHANGED)
    // -------------------------------------------------------------------
    if (eventName === "pull_request_review") {

      const { data: pullCommits } = await octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: pullNumber
      });

      const pullCommitsSHA = pullCommits[pullCommits.length - 1].sha;

      core.info(`Rerunning pull_request verification`);

      const checkRuns = (
        await octokit.rest.checks.listForRef({
          owner,
          repo,
          ref: pullCommitsSHA
        })
      ).data.check_runs;

      for (const check_run of checkRuns) {
        if (check_run.app.slug === "github-actions") {
          const job = (
            await octokit.rest.actions.getJobForWorkflowRun({
              owner,
              repo,
              job_id: check_run.id
            })
          ).data;

          const actionsRun = (
            await octokit.rest.actions.getWorkflowRun({
              owner,
              repo,
              run_id: job.run_id
            })
          ).data;

          if (actionsRun.event === "pull_request") {
            core.info(`Starting rerun post request`);

            await octokit.request(
              "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
              {
                owner,
                repo,
                run_id: actionsRun.id
              }
            );
          }
        }
      }
    }

  } catch (err) {
    core.setFailed(err.message);
  }
};

main();