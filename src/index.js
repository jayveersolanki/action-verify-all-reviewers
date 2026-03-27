const core = require('@actions/core');
const github = require('@actions/github');

const EXCLUDED_REVIEWERS = [
  "copilot", 
  "github-copilot",
  "github-actions[bot]",
  "dependabot[bot]"
];

const main = async () => {
  try {

    //#region Set script consts
    const eventName = core.getInput('event_name', { required: true });
    const owner = core.getInput('owner', { required: true });
    const repo = core.getInput('repo', { required: true });
    const token = core.getInput('token', { required: true });
    const pullNumber = core.getInput('pr_number', { required: true });
    const octokit = github.getOctokit(token);
    let shouldMerge = true;
    //#endregion

    //Get the current pr request
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner: owner,
      repo: repo,
      pull_number: pullNumber
    });

    // Filter reviewers excluding Copilot/bots
    const reviewers = pullRequest.requested_reviewers
      .filter(r => !EXCLUDED_REVIEWERS.includes(r.login));

    if (reviewers.length > 0) {
      core.setFailed(`${reviewers.length} reviewer(s) left to review (excluding bots).`);
      shouldMerge = false;
    }

    //#region Check for reviews and approvals
    const { data: reviewComments } = await octokit.rest.pulls.listReviews({
      owner: owner,
      repo: repo,
      pull_number: pullNumber
    });

    if (reviewComments.length > 0) {
      const latestReviewByUser = {};

      // Keep only final review state per user
      for (const review of reviewComments) {
        const login = review.user.login;

        // Skip bots/copilot
        if (EXCLUDED_REVIEWERS.includes(login)) continue;

        // Save last review state
        latestReviewByUser[login] = review.state;
      }

      const approvedUsers = [];
      const missingApprovals = [];

      for (const [user, state] of Object.entries(latestReviewByUser)) {
        if (state === "APPROVED") {
          approvedUsers.push(user);
        } else {
          // COMMENTED / CHANGES_REQUESTED / DISMISSED are failures
          missingApprovals.push(`${user} (${state})`);
        }
      }

      if (missingApprovals.length > 0) {
        core.setFailed(`All reviewers must approve. Missing approvals: ${missingApprovals.join(", ")}`);
        shouldMerge = false;
      } else if (approvedUsers.length === 0) {
        core.setFailed(`No approvals found from human reviewers.`);
        shouldMerge = false;
      } else {
        core.info(`Current Approver(s): ${approvedUsers.join(", ")}`);
      }

    } else {
      core.setFailed(`No reviewers found.`);
      shouldMerge = false;
    }
    //#endregion

    // Existing rerun logic untouched
    if (eventName === "pull_request_review") {
      const { data: pullCommits } = await octokit.rest.pulls.listCommits({
        owner: owner,
        repo: repo,
        pull_number: pullNumber
      });

      const pullCommitsSHA = pullCommits[pullCommits.length - 1].sha;

      core.info(`Rerunning pull_request verification`);

      const check_runs = (await octokit.rest.checks.listForRef({
        owner: owner,
        repo: repo,
        ref: pullCommitsSHA
      })).data.check_runs;

      for (var check_run of check_runs) {
        if (check_run.app.slug === 'github-actions') {
          const job = (await octokit.rest.actions.getJobForWorkflowRun({
            owner: owner,
            repo: repo,
            job_id: check_run.id,
          })).data;

          const actions_run = (await octokit.rest.actions.getWorkflowRun({
            owner: owner,
            repo: repo,
            run_id: job.run_id,
          })).data;

          if (actions_run.event === "pull_request") {
            core.info(`Starting rerun post request`);
            await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
              owner: owner,
              repo: repo,
              run_id: actions_run.id
            });
          }
        }
      }
    }

  } catch (error) {
    core.setFailed(error.message);
  }
};

main();