const core = require('@actions/core');
const github = require('@actions/github');

// All Copilot variants + known bots
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
    const owner     = core.getInput('owner', { required: true });
    const repo      = core.getInput('repo', { required: true });
    const token     = core.getInput('token', { required: true });
    const pullNumber = core.getInput('pr_number', { required: true });

    const octokit = github.getOctokit(token);

    // Fetch PR details
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner, repo, pull_number: pullNumber
    });

    // -----------------------------------------------------------------------
    // FIX #1: Filter Copilot/bots BEFORE checking if reviewers left
    // -----------------------------------------------------------------------
    const rawReviewers = pullRequest.requested_reviewers;
    const humanReviewers = rawReviewers
      .map(r => r.login)
      .filter(login => !EXCLUDED_REVIEWERS.includes(login));

    if (humanReviewers.length > 0) {
      core.setFailed(
        `${humanReviewers.length} reviewer(s) left to review: ${humanReviewers.join(", ")}`
      );
      return;
    }

    // -----------------------------------------------------------------------
    // Fetch and process review comments
    // -----------------------------------------------------------------------
    const { data: reviewComments } = await octokit.rest.pulls.listReviews({
      owner, repo, pull_number: pullNumber
    });

    if (reviewComments.length === 0) {
      core.setFailed(`No reviewers found.`);
      return;
    }

    // Track only MOST RECENT review state by each HUMAN reviewer
    const latestReviewByUser = {};

    for (const review of reviewComments) {
      const login = review.user.login;

      // Skip all excluded reviewers
      if (EXCLUDED_REVIEWERS.includes(login)) continue;

      latestReviewByUser[login] = review.state;
    }

    // Find who approved vs who did NOT approve
    const approvedUsers = [];
    const missingApprovals = [];

    for (const [login, state] of Object.entries(latestReviewByUser)) {
      if (state === "APPROVED") {
        approvedUsers.push(login);
      } else {
        missingApprovals.push(`${login} (${state})`);
      }
    }

    // -----------------------------------------------------------------------
    // FIX #2 & #3: Ignore bots fully; only fail for humans
    // -----------------------------------------------------------------------
    if (missingApprovals.length > 0) {
      core.setFailed(
        `All reviewers must approve. Missing approvals: ${missingApprovals.join(", ")}`
      );
      return;
    }

    if (approvedUsers.length === 0) {
      core.setFailed(`No approvals found from human reviewers.`);
      return;
    }

    core.info(`Current Approver(s): ${approvedUsers.join(", ")}`);

    // -----------------------------------------------------------------------
    // Existing rerun logic (unchanged)
    // -----------------------------------------------------------------------
    if (eventName === "pull_request_review") {

      const { data: pullCommits } = await octokit.rest.pulls.listCommits({
        owner, repo, pull_number: pullNumber
      });

      const pullCommitsSHA = pullCommits[pullCommits.length - 1].sha;
      core.info(`Rerunning pull_request verification`);

      const check_runs = (
        await octokit.rest.checks.listForRef({
          owner, repo, ref: pullCommitsSHA
        })
      ).data.check_runs;

      for (const check_run of check_runs) {
        if (check_run.app.slug === "github-actions") {

          const job = (
            await octokit.rest.actions.getJobForWorkflowRun({
              owner, repo, job_id: check_run.id
            })
          ).data;

          const actions_run = (
            await octokit.rest.actions.getWorkflowRun({
              owner, repo, run_id: job.run_id
            })
          ).data;

          if (actions_run.event === "pull_request") {
            core.info(`Starting rerun post request`);
            await octokit.request(
              "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
              {
                owner, repo,
                run_id: actions_run.id
              }
            );
          }
        }
      }
    }

  } catch (error) {
    core.setFailed(error.message);
  }
};

main();