import { randomUUID } from "node:crypto";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import type {
  SqliteWorkerEphemeralTarget,
  SqliteWorkerStore,
} from "../infra/sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AgentCreationClaimWitness } from "./agent-creation-claim.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import type {
  AgentDatabaseGenerationClaim,
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseAdmissionExecution,
} from "./openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseDomainOperations } from "./openclaw-agent-execution-domain.js";
import type { RegisteredAgentWorkerOperations } from "./openclaw-agent-execution-operations.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** Recorded by the native owner; a descriptor never grants access to that owner. */
export type AgentDatabaseFileExecutionIdentity = {
  kind: "file";
  physicalIdentity: string;
  birthtime?: string;
  incarnation: string;
  nativeLocation: string;
};

export type AgentDatabaseExecutionFileIdentity = Pick<
  AgentDatabaseFileExecutionIdentity,
  "kind" | "physicalIdentity" | "birthtime" | "nativeLocation"
>;

export type AgentDatabaseNativeStore = SqliteWorkerStore<AgentDatabaseOperations>;
export type AgentDatabaseExecutionScope = Pick<AgentDatabaseNativeStore, "execute">;

export type OpenClawAgentDatabaseExecution = OpenClawAgentDatabaseAdmissionExecution & {
  /** The accepted native receipt; reading this never adopts the current pathname. */
  readonly fileIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  /** Accept the admitted native handle used by a synchronous SDK operation. */
  adoptNativeDatabase(database: OpenClawAgentDatabase): Promise<void>;
  /** Reuse only a native generation whose preparation and registration publication settled. */
  capturePreparedGenerationClaim(): AgentDatabaseGenerationClaim | undefined;
  /** Admit a write against existing storage; a missing store remains missing. */
  runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    options?:
      | { retireNativeOnFailure: true; withAdmission?: never }
      | {
          retireNativeOnFailure?: never;
          /** Track read admission; cancellation removes only a waiting host-queue task. */
          withAdmission: <Result>(
            run: () => Promise<Result>,
            signal: AbortSignal,
          ) => Promise<Result>;
        },
  ): Promise<T | undefined>;
  /**
   * Join this reference's work; native cleanup failures remain with its resource owner.
   * The owner may retain one bounded idle generation.
   */
  release(): Promise<void>;
};

export type AgentDatabaseFileExecutionOwner = {
  readonly kind: "file";
  readonly agentId: string;
  readonly sharedDatabaseKey: string;
  readonly creationIdentity?: DatabasePathIdentity;
  borrow(
    pathname: string,
    expectedIdentity?: AgentDatabaseExecutionFileIdentity,
    expectedCreationIdentity?: DatabasePathIdentity,
    requestedPath?: string,
    protectedStorage?: true,
  ): OpenClawAgentDatabaseExecution;
  closeIdle(): Promise<void>;
  close(): Promise<void>;
};

export type AgentDatabaseNativeGeneration = {
  failure(): "open-refused" | "native" | undefined;
  isPrepared(): boolean;
  captureClaim(): AgentDatabaseGenerationClaim;
  run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    createIfMissing?: boolean,
    signal?: AbortSignal,
    readmitSchema?: boolean,
  ): Promise<T | undefined>;
  close(): Promise<void>;
};

type AgentDatabaseFileExecutionOpenBase = {
  kind?: "file";
  leaseId: string;
  agentId: string;
  databasePath: string;
  stateDatabasePath: string;
  environment: SqliteWorkerStateContext["environment"];
};

export type AgentDatabaseFileExecutionOpen =
  | (AgentDatabaseFileExecutionOpenBase & {
      expectedIdentity?: AgentDatabaseExecutionFileIdentity;
      /** Captured before a creating request yields; absence is an identity too. */
      creatingIdentity?: DatabasePathIdentity;
      creationClaim?: AgentCreationClaimWitness;
      protectedStorage?: never;
    })
  | (AgentDatabaseFileExecutionOpenBase & {
      /** The prepared physical store; the worker never creates or replaces it. */
      expectedIdentity: AgentDatabaseExecutionFileIdentity;
      /** Explicit host grant: refuse an unencrypted or unmarked store before schema work. */
      protectedStorage: true;
      creatingIdentity?: never;
      creationClaim?: never;
    });

/** Builds the worker open input; the protected grant only admits an existing prepared store. */
export function createAgentDatabaseFileExecutionOpen(
  agentId: string,
  databasePath: string,
  context: Pick<OpenClawStateWorkerContext, "admission" | "environment">,
  identities: {
    expectedIdentity?: AgentDatabaseExecutionFileIdentity;
    creatingIdentity?: DatabasePathIdentity;
    creationClaim?: AgentCreationClaimWitness;
    protectedStorage?: true;
  },
): AgentDatabaseFileExecutionOpen {
  const { expectedIdentity, creatingIdentity, creationClaim, protectedStorage } = identities;
  const base = {
    leaseId: randomUUID(),
    agentId,
    databasePath,
    stateDatabasePath: context.admission.databasePath,
    environment: context.environment,
  };
  if (protectedStorage) {
    if (!expectedIdentity || creatingIdentity || creationClaim) {
      throw new Error("Protected agent execution requires an existing prepared physical store");
    }
    return { ...base, expectedIdentity, protectedStorage };
  }
  return {
    ...base,
    ...(expectedIdentity ? { expectedIdentity } : {}),
    ...(creatingIdentity ? { creatingIdentity } : {}),
    ...(creationClaim ? { creationClaim } : {}),
  };
}

/** Protected execution never initializes a store; a missing one stays unadmitted until setup. */
export function assertProtectedAgentStoreRun(
  protectedStorage: true | undefined,
  createIfMissing: boolean,
  missing = false,
): void {
  if (protectedStorage && createIfMissing) {
    throw new Error("Protected agent execution never initializes its physical store");
  }
  if (protectedStorage && missing) {
    throw new Error("Protected agent store is missing; it needs setup before admission");
  }
}

/** Process-private locators; neither a handle nor its incarnation grants authority. */
export type AgentDatabaseIncognitoIdentity = Readonly<SqliteWorkerEphemeralTarget>;

export type AgentDatabaseIncognitoOpen = {
  kind: "ephemeral";
  identity: AgentDatabaseIncognitoIdentity;
  agentId: string;
  databasePath: string;
  environment: SqliteWorkerStateContext["environment"];
};

export type AgentDatabaseExecutionOpen =
  | AgentDatabaseFileExecutionOpen
  | AgentDatabaseIncognitoOpen;

export type AgentDatabaseIncognitoAuthority = { assertCurrent(): void };

export type AgentDatabaseOperations = AgentDatabaseDomainOperations &
  RegisteredAgentWorkerOperations & {
    "database.walMaintenance": { input: SqliteWalPeriodicRequest; output: SqliteWalPeriodicResult };
    "database.prepareWrite": { input: undefined; output: void };
    "database.recordIntegrity": { input: undefined; output: boolean };
  };
