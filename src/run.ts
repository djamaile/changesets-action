import { exec } from "@actions/exec";
import * as github from "@actions/github";
import fs from "fs-extra";
import { getPackages, Package } from "@manypkg/get-packages";
import path from "path";
import * as semver from "semver";
import {
  getChangelogEntry,
  execWithOutput,
  getChangedPackages,
  sortTheThings,
  getVersionsByDirectory,
} from "./utils";
import * as gitUtils from "./gitUtils";
import readChangesetState from "./readChangesetState";
import resolveFrom from "resolve-from";

const createRelease = async (
  octokit: ReturnType<typeof github.getOctokit>,
  { pkg, tagName }: { pkg: Package; tagName: string }
) => {
  try {
    let changelogFileName = path.join(pkg.dir, "CHANGELOG.md");

    let changelog = await fs.readFile(changelogFileName, "utf8");

    let changelogEntry = getChangelogEntry(changelog, pkg.packageJson.version);
    if (!changelogEntry) {
      // we can find a changelog but not the entry for this version
      // if this is true, something has probably gone wrong
      throw new Error(
        `Could not find changelog entry for ${pkg.packageJson.name}@${pkg.packageJson.version}`
      );
    }

    await octokit.repos.createRelease({
      name: tagName,
      tag_name: tagName,
      body: changelogEntry.content,
      prerelease: pkg.packageJson.version.includes("-"),
      ...github.context.repo,
    });
  } catch (err) {
    // if we can't find a changelog, the user has probably disabled changelogs
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
};

type PublishOptions = {
  script: string;
  githubToken: string;
  createGithubReleases: boolean;
  cwd?: string;
};

type PublishedPackage = { name: string; version: string };

type PublishResult =
  | {
      published: true;
      publishedPackages: PublishedPackage[];
    }
  | {
      published: false;
    };

export async function runPublish({
  script,
  githubToken,
  createGithubReleases,
  cwd = process.cwd(),
}: PublishOptions): Promise<PublishResult> {
  let octokit = github.getOctokit(githubToken);
  let [publishCommand, ...publishArgs] = script.split(/\s+/);

  let changesetPublishOutput = await execWithOutput(
    publishCommand,
    publishArgs,
    { cwd }
  );

  await gitUtils.pushTags();

  let { packages, tool } = await getPackages(cwd);
  let releasedPackages: Package[] = [];

  if (tool !== "root") {
    let newTagRegex = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/;
    let packagesByName = new Map(packages.map((x) => [x.packageJson.name, x]));

    for (let line of changesetPublishOutput.stdout.split("\n")) {
      let match = line.match(newTagRegex);
      if (match === null) {
        continue;
      }
      let pkgName = match[1];
      let pkg = packagesByName.get(pkgName);
      if (pkg === undefined) {
        throw new Error(
          `Package "${pkgName}" not found.` +
            "This is probably a bug in the action, please open an issue"
        );
      }
      releasedPackages.push(pkg);
    }

    if (createGithubReleases) {
      await Promise.all(
        releasedPackages.map((pkg) =>
          createRelease(octokit, {
            pkg,
            tagName: `${pkg.packageJson.name}@${pkg.packageJson.version}`,
          })
        )
      );
    }
  } else {
    if (packages.length === 0) {
      throw new Error(
        `No package found.` +
          "This is probably a bug in the action, please open an issue"
      );
    }
    let pkg = packages[0];
    let newTagRegex = /New tag:/;

    for (let line of changesetPublishOutput.stdout.split("\n")) {
      let match = line.match(newTagRegex);

      if (match) {
        releasedPackages.push(pkg);
        if (createGithubReleases) {
          await createRelease(octokit, {
            pkg,
            tagName: `v${pkg.packageJson.version}`,
          });
        }
        break;
      }
    }
  }

  if (releasedPackages.length) {
    return {
      published: true,
      publishedPackages: releasedPackages.map((pkg) => ({
        name: pkg.packageJson.name,
        version: pkg.packageJson.version,
      })),
    };
  }

  return { published: false };
}

const requireChangesetsCliPkgJson = (cwd: string) => {
  try {
    return require(resolveFrom(cwd, "@changesets/cli/package.json"));
  } catch (err) {
    if (err && err.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `Have you forgotten to install \`@changesets/cli\` in "${cwd}"?`
      );
    }
    throw err;
  }
};

type VersionOptions = {
  script?: string;
  githubToken: string;
  cwd?: string;
  prTitle?: string;
  commitMessage?: string;
  hasPublishScript?: boolean;
  changelogPath?: string;
  releaseVersion?: string;
};

type RunVersionResult = {
  pullRequestNumber: number;
};

function splitAndCapitalize(str: string) {
  let words = str.split('-');
  words.shift();
  return words
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export async function runVersion({
  script,
  githubToken,
  cwd = process.cwd(),
  releaseVersion,
  prTitle = "Version Packages",
  commitMessage = "Version Packages",
  hasPublishScript = false,
  changelogPath = "docs/releases",
}: VersionOptions): Promise<RunVersionResult> {
  let repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  let branch = github.context.ref.replace("refs/heads/", "");
  let versionBranch = `changeset-release/${branch}`;
  let octokit = github.getOctokit(githubToken);
  let { preState } = await readChangesetState(cwd);

  await gitUtils.switchToMaybeExistingBranch(versionBranch);
  await gitUtils.reset(github.context.sha);

  let versionsByDirectory = await getVersionsByDirectory(cwd);

  if (script) {
    let [versionCommand, ...versionArgs] = script.split(/\s+/);
    await exec(versionCommand, versionArgs, { cwd });
  } else {
    let changesetsCliPkgJson = requireChangesetsCliPkgJson(cwd);
    let cmd = semver.lt(changesetsCliPkgJson.version, "2.0.0")
      ? "bump"
      : "version";
    await exec("node", [resolveFrom(cwd, "@changesets/cli/bin.js"), cmd], {
      cwd,
    });
  }

  let searchQuery = `repo:${repo}+state:open+head:${versionBranch}+base:${branch}`;
  let searchResultPromise = octokit.search.issuesAndPullRequests({
    q: searchQuery,
  });
  let changedPackages = await getChangedPackages(cwd, versionsByDirectory);

  const { version: versionFromPackageJson } = await fs.readJson(
    path.resolve(cwd, "package.json")
  );
  const toUseReleaseVersion = releaseVersion || versionFromPackageJson;

  const changelogEntries = await Promise.all(
    changedPackages.map(async (pkg) => {
      let changelogContents = await fs.readFile(
        path.join(pkg.dir, "CHANGELOG.md"),
        "utf8"
      );

      let entry = getChangelogEntry(changelogContents, pkg.packageJson.version);
      return {
        highestLevel: entry.highestLevel,
        private: !!pkg.packageJson.private,
        content:
          `## ${splitAndCapitalize(pkg.packageJson.name)}\n\n` +
          entry.content,
      };
    })
  );

  function splitContent(content: string, existingObj: Record<string, {major: string, patch: string}>) {
    const pluginName = content.split('\n')[0].replace('## ', '').trim();
    const majorIndex = content.indexOf('Major Changes');
    const patchIndex = content.indexOf('Patch Changes');
    
    let major = '', patch = '';
  
    // Check if Major Changes is present
    if (majorIndex !== -1) {
      if (patchIndex !== -1) {
        major = content.slice(majorIndex, patchIndex).trim().replace("###", '');
      } else {
        major = content.slice(majorIndex).trim();
      }
    }
  
    // Check if Patch Changes is present
    if (patchIndex !== -1) {
      patch = content.slice(patchIndex).trim();
    }
  
    // Set the properties in the existing object
    existingObj[pluginName] = {
      major,
      patch
    };
  }
  const pluginChanges: Record<string, {major: string, patch: string}> = {};
  for(const item of changelogEntries){
    splitContent(item.content, pluginChanges);
  }
  const features: string[] = [];
  const bugfixes: string[] = [];
  for(const [pluginName, changes] of Object.entries(pluginChanges)){
    const majorChanges = changes.major;
    const patchChanges = changes.patch;
    if(changes.major !== ''){
      features.push(`
         ### ${pluginName}
         ${majorChanges.split("Changes")[1].trim()}
      `);
    }
    if(changes.patch !== ''){
      bugfixes.push(`
         ### ${pluginName}
         ${patchChanges.split("Changes")[1].trim()}
      `);
    }
  }

  const markdown = `
  ## Features
  ${features.join('\n')}
  
  ## Bug fixes
  ${bugfixes.join('\n')}
  `;
  
  const lines = markdown.split('\n');
  const trimmedLines = lines.map(line => line.trimStart());
  const alignedMarkdown = trimmedLines.join('\n');

  let changelogBody = `
# Release v${toUseReleaseVersion}

${alignedMarkdown}
`;


  const file = `v${releaseVersion}-changelog.md`;
  const fullChangelogPath = `${changelogPath}/${file}`;

  try {
    const prettier = require(resolveFrom(cwd, "prettier"));
    const prettierConfig = await prettier.resolveConfig(cwd);
    changelogBody = prettier.format(changelogBody, {
      ...prettierConfig,
      parser: "markdown",
    });
  } catch {}

  console.log('fullChangelogPath', fullChangelogPath);

  await fs.writeFile(fullChangelogPath, changelogBody);

  const prBody = `See [${fullChangelogPath}](https://github.com/backstage/backstage/blob/master/${fullChangelogPath}) for more information.\n\n`;

  const finalPrTitle = `${prTitle}${!!preState ? ` (${preState.tag})` : ""}`;

  // project with `commit: true` setting could have already committed files
  if (!(await gitUtils.checkIfClean())) {
    const finalCommitMessage = `${commitMessage}${
      !!preState ? ` (${preState.tag})` : ""
    }`;
    await gitUtils.commitAll(finalCommitMessage);
  }

  await gitUtils.push(versionBranch, { force: true });

  let searchResult = await searchResultPromise;
  console.log(JSON.stringify(searchResult.data, null, 2));
  if (searchResult.data.items.length === 0) {
    console.log("creating pull request");
    const {
      data: { number },
    } = await octokit.pulls.create({
      base: branch,
      head: versionBranch,
      title: finalPrTitle,
      body: prBody,
      ...github.context.repo,
    });

    return {
      pullRequestNumber: number,
    };
  } else {
    await octokit.pulls.update({
      pull_number: searchResult.data.items[0].number,
      title: finalPrTitle,
      body: prBody,
      ...github.context.repo,
    });
    console.log("pull request found");

    return {
      pullRequestNumber: searchResult.data.items[0].number,
    };
  }
}
