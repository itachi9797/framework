import type {
	ContextMenuCommandBuilder,
	SlashCommandBuilder,
	SlashCommandOptionsOnlyBuilder,
	SlashCommandSubcommandsOnlyBuilder
} from '@discordjs/builders';
import { container } from '@sapphire/pieces';
import { isNullishOrEmpty } from '@sapphire/utilities';
import {
	ApplicationCommandType,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
	type RESTPostAPIContextMenuApplicationCommandsJSONBody
} from 'discord-api-types/v10';
import {
	Collection,
	type ApplicationCommand,
	type ApplicationCommandManager,
	type ChatInputApplicationCommandData,
	type MessageApplicationCommandData,
	type UserApplicationCommandData
} from 'discord.js';
import { InternalRegistryAPIType, RegisterBehavior } from '../../types/Enums';
import { allGuildIdsToFetchCommandsFor, getDefaultBehaviorWhenNotIdentical, getDefaultGuildIds } from './ApplicationCommandRegistries';
import type { CommandDifference } from './compute-differences/_shared';
import { getCommandDifferences, getCommandDifferencesFast } from './computeDifferences';
import { convertApplicationCommandToApiData, normalizeChatInputCommand, normalizeContextMenuCommand } from './normalizeInputs';

export class ApplicationCommandRegistry {
	/**
	 * The piece this registry is for.
	 */
	public readonly commandName: string;

	/**
	 * A set of all chat input command names and ids that point to this registry.
	 * You should not use this field directly, but instead use {@link ApplicationCommandRegistry.globalChatInputCommandIds}
	 */
	public readonly chatInputCommands = new Set<string>();

	/**
	 * A set of all context menu command names and ids that point to this registry.
	 * You should not use this field directly, but instead use {@link ApplicationCommandRegistry.globalContextMenuCommandIds}
	 */
	public readonly contextMenuCommands = new Set<string>();

	/**
	 * The guild ids that we need to fetch the commands for.
	 */
	public readonly guildIdsToFetch = new Set<string>();

	/**
	 * The global slash command id for this command.
	 * @deprecated This field will only show the first global command id registered for this registry.
	 * Use {@link ApplicationCommandRegistry.globalChatInputCommandIds} instead.
	 */
	public globalCommandId: string | null = null;

	/**
	 * A set of all registered and valid global chat input command ids that point to this registry.
	 */
	public readonly globalChatInputCommandIds = new Set<string>();

	/**
	 * A set of all registered and valid global context menu command ids that point to this registry.
	 */
	public readonly globalContextMenuCommandIds = new Set<string>();

	/**
	 * The guild command ids for this command.
	 * @deprecated This field will only show the first guild command id registered for this registry per guild.
	 * Use {@link ApplicationCommandRegistry.guildIdToChatInputCommandIds} and {@link ApplicationCommandRegistry.guildIdToContextMenuCommandIds} instead.
	 */
	public readonly guildCommandIds = new Collection<string, string>();

	/**
	 * A map of guild ids to a set of registered and valid chat input command ids that point to this registry.
	 */
	public readonly guildIdToChatInputCommandIds = new Collection<string, Set<string>>();

	/**
	 * A map of guild ids to a set of registered and valid context menu command ids that point to this registry.
	 */
	public readonly guildIdToContextMenuCommandIds = new Collection<string, Set<string>>();

	private readonly apiCalls: InternalAPICall[] = [];

	public constructor(commandName: string) {
		this.commandName = commandName;
	}

	public get command() {
		return container.stores.get('commands').get(this.commandName);
	}

	public registerChatInputCommand(
		command:
			| ChatInputApplicationCommandData
			| SlashCommandBuilder
			| SlashCommandSubcommandsOnlyBuilder
			| SlashCommandOptionsOnlyBuilder
			| Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>
			| ((builder: SlashCommandBuilder) => unknown),
		options?: ApplicationCommandRegistryRegisterOptions
	) {
		const builtData = normalizeChatInputCommand(command);

		this.chatInputCommands.add(builtData.name);

		const guildIdsToRegister = this.getGuildIdsToRegister(options);

		this.apiCalls.push({
			builtData,
			registerOptions: options ?? {
				registerCommandIfMissing: true,
				behaviorWhenNotIdentical: getDefaultBehaviorWhenNotIdentical(),
				guildIds: guildIdsToRegister
			},
			type: InternalRegistryAPIType.ChatInput
		});

		if (options?.idHints) {
			for (const hint of options.idHints) {
				this.chatInputCommands.add(hint);
			}
		}

		this.processGuildIds(guildIdsToRegister);

		return this;
	}

	public registerContextMenuCommand(
		command:
			| UserApplicationCommandData
			| MessageApplicationCommandData
			| ContextMenuCommandBuilder
			| ((builder: ContextMenuCommandBuilder) => unknown),
		options?: ApplicationCommandRegistryRegisterOptions
	) {
		const builtData = normalizeContextMenuCommand(command);

		this.contextMenuCommands.add(builtData.name);

		const guildIdsToRegister = this.getGuildIdsToRegister(options);

		this.apiCalls.push({
			builtData,
			registerOptions: options ?? {
				registerCommandIfMissing: true,
				behaviorWhenNotIdentical: getDefaultBehaviorWhenNotIdentical(),
				guildIds: guildIdsToRegister
			},
			type: InternalRegistryAPIType.ContextMenu
		});

		if (options?.idHints) {
			for (const hint of options.idHints) {
				this.contextMenuCommands.add(hint);
			}
		}

		this.processGuildIds(guildIdsToRegister);

		return this;
	}

	public addChatInputCommandNames(...names: string[] | string[][]) {
		const flattened = names.flat(Infinity) as string[];

		for (const command of flattened) {
			this.debug(`Registering name "${command}" to internal chat input map`);
			this.warn(
				`Registering the chat input command "${command}" using a name is not recommended.`,
				'Please use the "addChatInputCommandIds" method instead with a command id.'
			);
			this.chatInputCommands.add(command);
		}

		return this;
	}

	public addContextMenuCommandNames(...names: string[] | string[][]) {
		const flattened = names.flat(Infinity) as string[];

		for (const command of flattened) {
			this.debug(`Registering name "${command}" to internal context menu map`);
			this.warn(
				`Registering the context menu command "${command}" using a name is not recommended.`,
				'Please use the "addContextMenuCommandIds" method instead with a command id.'
			);
			this.contextMenuCommands.add(command);
		}

		return this;
	}

	public addChatInputCommandIds(...commandIds: string[] | string[][]) {
		const flattened = commandIds.flat(Infinity) as string[];

		for (const entry of flattened) {
			try {
				BigInt(entry);
				this.debug(`Registering id "${entry}" to internal chat input map`);
			} catch {
				// Don't be silly, save yourself the headaches and do as we say
				this.debug(`Registering name "${entry}" to internal chat input map`);
				this.warn(
					`Registering the chat input command "${entry}" using a name *and* trying to bypass this warning by calling "addChatInputCommandIds" is not recommended.`,
					'Please use the "addChatInputCommandIds" method with a valid command id instead.'
				);
			}
			this.chatInputCommands.add(entry);
		}

		return this;
	}

	public addContextMenuCommandIds(...commandIds: string[] | string[][]) {
		const flattened = commandIds.flat(Infinity) as string[];

		for (const entry of flattened) {
			try {
				BigInt(entry);
				this.debug(`Registering id "${entry}" to internal context menu map`);
			} catch {
				this.debug(`Registering name "${entry}" to internal context menu map`);
				// Don't be silly, save yourself the headaches and do as we say
				this.warn(
					`Registering the context menu command "${entry}" using a name *and* trying to bypass this warning by calling "addContextMenuCommandIds" is not recommended.`,
					'Please use the "addContextMenuCommandIds" method with a valid command id instead.'
				);
			}
			this.contextMenuCommands.add(entry);
		}

		return this;
	}

	protected async runAPICalls(
		applicationCommands: ApplicationCommandManager,
		globalCommands: Collection<string, ApplicationCommand>,
		guildCommands: Map<string, Collection<string, ApplicationCommand>>
	) {
		// Early return for no API calls
		if (this.apiCalls.length === 0) {
			// If we have no API calls to do then we simply return (can happen if the registry is used directly)
			this.trace('No API calls to run, and no command to register');

			return;
		}

		if (getDefaultBehaviorWhenNotIdentical() === RegisterBehavior.BulkOverwrite) {
			throw new RangeError(
				`"runAPICalls" was called for "${this.commandName}" but the defaultBehaviorWhenNotIdentical is "BulkOverwrite". This should not happen.`
			);
		}

		this.debug(`Preparing to process ${this.apiCalls.length} possible command registrations / updates...`);

		const results = await Promise.allSettled(
			this.apiCalls.map((call) => this.handleAPICall(applicationCommands, globalCommands, guildCommands, call))
		);

		const errored = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];

		if (errored.length) {
			this.error(`Received ${errored.length} errors while processing command registrations / updates`);

			for (const error of errored) {
				this.error(error.reason.stack ?? error.reason);
			}
		}
	}

	protected handleIdAddition(type: InternalRegistryAPIType, id: string, guildId?: string | null) {
		switch (type) {
			case InternalRegistryAPIType.ChatInput: {
				this.addChatInputCommandIds(id);

				if (guildId) {
					this.guildIdToChatInputCommandIds.ensure(guildId, () => new Set()).add(id);
				} else {
					this.globalChatInputCommandIds.add(id);
				}
				break;
			}
			case InternalRegistryAPIType.ContextMenu: {
				this.addContextMenuCommandIds(id);

				if (guildId) {
					this.guildIdToContextMenuCommandIds.ensure(guildId, () => new Set()).add(id);
				} else {
					this.globalContextMenuCommandIds.add(id);
				}
				break;
			}
		}

		// Old field handling
		if (guildId) {
			// Old, wrongly typed field (thx kyra for spotting >_>)
			if (!this.guildCommandIds.has(guildId)) {
				this.guildCommandIds.set(guildId, id);
			}
		} else {
			// First come, first serve (thx kyra for spotting >_>)
			this.globalCommandId ??= id;
		}
	}

	private getGuildIdsToRegister(options?: ApplicationCommandRegistryRegisterOptions) {
		let guildIdsToRegister: ApplicationCommandRegistry.RegisterOptions['guildIds'] = undefined;

		if (!isNullishOrEmpty(options?.guildIds)) {
			guildIdsToRegister = options!.guildIds;
		} else if (!isNullishOrEmpty(getDefaultGuildIds())) {
			guildIdsToRegister = getDefaultGuildIds();
		}

		return guildIdsToRegister;
	}

	private processGuildIds(guildIdsToRegister: ApplicationCommandRegistry.RegisterOptions['guildIds']) {
		if (!isNullishOrEmpty(guildIdsToRegister)) {
			for (const id of guildIdsToRegister) {
				this.guildIdsToFetch.add(id);
				allGuildIdsToFetchCommandsFor.add(id);
			}
		}
	}

	private async handleAPICall(
		commandsManager: ApplicationCommandManager,
		globalCommands: Collection<string, ApplicationCommand>,
		allGuildsCommands: Map<string, Collection<string, ApplicationCommand>>,
		apiCall: InternalAPICall
	) {
		const { builtData, registerOptions } = apiCall;
		const commandName = builtData.name;
		const behaviorIfNotEqual = registerOptions.behaviorWhenNotIdentical ?? getDefaultBehaviorWhenNotIdentical();

		const findCallback = (entry: ApplicationCommand) => {
			// If the command is a chat input command, we need to check if the entry is a chat input command
			if (apiCall.type === InternalRegistryAPIType.ChatInput && entry.type !== ApplicationCommandType.ChatInput) return false;
			// If the command is a context menu command, we need to check if the entry is a context menu command of the same type
			if (apiCall.type === InternalRegistryAPIType.ContextMenu) {
				// If its a chat input command, it doesn't match
				if (entry.type === ApplicationCommandType.ChatInput) return false;
				// Check the command type (must match)
				if (apiCall.builtData.type !== entry.type) return false;
			}

			// Find the command by name or by id hint (mostly useful for context menus)
			const isInIdHint = registerOptions.idHints?.includes(entry.id);
			return typeof isInIdHint === 'boolean' ? isInIdHint || entry.name === commandName : entry.name === commandName;
		};

		let type: string;

		switch (apiCall.type) {
			case InternalRegistryAPIType.ChatInput:
				type = 'chat input';
				break;
			case InternalRegistryAPIType.ContextMenu:
				switch (apiCall.builtData.type) {
					case ApplicationCommandType.Message:
						type = 'message context menu';
						break;
					case ApplicationCommandType.User:
						type = 'user context menu';
						break;
					default:
						type = 'unknown-type context menu';
				}
				break;
			default:
				type = 'unknown';
		}

		if (!registerOptions.guildIds?.length) {
			const globalCommand = globalCommands.find(findCallback);

			if (globalCommand) {
				this.debug(`Checking if command "${commandName}" is identical with global ${type} command with id "${globalCommand.id}"`);
				this.handleIdAddition(apiCall.type, globalCommand.id);
				await this.handleCommandPresent(globalCommand, builtData, behaviorIfNotEqual, null);
			} else if (registerOptions.registerCommandIfMissing ?? true) {
				this.debug(`Creating new global ${type} command with name "${commandName}"`);
				await this.createMissingCommand(commandsManager, builtData, type);
			} else {
				this.debug(`Doing nothing about missing global ${type} command with name "${commandName}"`);
			}

			return;
		}

		for (const guildId of registerOptions.guildIds) {
			const guildCommands = allGuildsCommands.get(guildId);

			if (!guildCommands) {
				this.debug(`There are no commands for guild with id "${guildId}". Will create ${type} command "${commandName}".`);
				await this.createMissingCommand(commandsManager, builtData, type, guildId);
				continue;
			}

			const existingGuildCommand = guildCommands.find(findCallback);

			if (existingGuildCommand) {
				this.debug(`Checking if guild ${type} command "${commandName}" is identical to command "${existingGuildCommand.id}"`);
				this.handleIdAddition(apiCall.type, existingGuildCommand.id, guildId);
				await this.handleCommandPresent(existingGuildCommand, builtData, behaviorIfNotEqual, guildId);
			} else if (registerOptions.registerCommandIfMissing ?? true) {
				this.debug(`Creating new guild ${type} command with name "${commandName}" for guild "${guildId}"`);
				await this.createMissingCommand(commandsManager, builtData, type, guildId);
			} else {
				this.debug(`Doing nothing about missing guild ${type} command with name "${commandName}" for guild "${guildId}"`);
			}
		}
	}

	private async handleCommandPresent(
		applicationCommand: ApplicationCommand,
		apiData: InternalAPICall['builtData'],
		behaviorIfNotEqual: RegisterBehavior,
		guildId: string | null
	) {
		if (behaviorIfNotEqual === RegisterBehavior.BulkOverwrite) {
			this.debug(
				`Command "${this.commandName}" has the behaviorIfNotEqual set to "BulkOverwrite" which is invalid. Using defaultBehaviorWhenNotIdentical instead`
			);

			behaviorIfNotEqual = getDefaultBehaviorWhenNotIdentical();

			if (behaviorIfNotEqual === RegisterBehavior.BulkOverwrite) {
				throw new Error(
					`Invalid behaviorIfNotEqual value ("BulkOverwrite") for command "${this.commandName}", and defaultBehaviorWhenNotIdentical is also "BulkOverwrite". This should not happen.`
				);
			}
		}

		let differences: CommandDifference[] = [];

		if (behaviorIfNotEqual === RegisterBehavior.VerboseOverwrite) {
			const now = Date.now();

			// Step 0: compute differences
			differences = [...getCommandDifferences(convertApplicationCommandToApiData(applicationCommand), apiData, guildId !== null)];

			const later = Date.now() - now;
			this.debug(`Took ${later}ms to process differences via computing differences`);

			// Step 1: if there are no differences, return
			if (!differences.length) {
				this.debug(
					`${guildId ? 'Guild command' : 'Command'} "${apiData.name}" is identical to command "${applicationCommand.name}" (${
						applicationCommand.id
					})`
				);
				return;
			}
		}

		// Run the fast path even if the user wants to just log if the command has a difference
		if (behaviorIfNotEqual === RegisterBehavior.Overwrite || behaviorIfNotEqual === RegisterBehavior.LogToConsole) {
			const now = Date.now();

			// Step 0: compute differences
			const areThereDifferences = getCommandDifferencesFast(convertApplicationCommandToApiData(applicationCommand), apiData, guildId !== null);

			const later = Date.now() - now;
			this.debug(`Took ${later}ms to process differences via fast compute differences`);

			// Step 1: if there are no differences, return
			if (!areThereDifferences) {
				this.debug(
					`${guildId ? 'Guild command' : 'Command'} "${apiData.name}" is identical to command "${applicationCommand.name}" (${
						applicationCommand.id
					})`
				);
				return;
			}
		}

		this.logCommandDifferencesFound(applicationCommand, behaviorIfNotEqual === RegisterBehavior.LogToConsole, differences);

		// Step 2: if the behavior is to log to console, only log the differences
		if (behaviorIfNotEqual === RegisterBehavior.LogToConsole) {
			return;
		}

		// Step 3: if the behavior is to update, update the command
		try {
			await applicationCommand.edit(apiData as ChatInputApplicationCommandData);
			this.debug(`Updated command ${applicationCommand.name} (${applicationCommand.id}) with new api data`);
		} catch (error) {
			this.error(`Failed to update command ${applicationCommand.name} (${applicationCommand.id})`, error);
		}
	}

	private logCommandDifferencesFound(applicationCommand: ApplicationCommand, logAsWarn: boolean, differences: CommandDifference[]) {
		const finalMessage: string[] = [];
		const pad = ' '.repeat(5);

		for (const difference of differences) {
			finalMessage.push(
				[
					`└── At path: ${difference.key}`, //
					`${pad}├── Received: ${difference.original}`,
					`${pad}└── Expected: ${difference.expected}`,
					''
				].join('\n')
			);
		}

		const finalMessageNewLine = finalMessage.length ? '\n' : '';
		const header = `Found differences for command "${applicationCommand.name}" (${applicationCommand.id}) versus provided api data.${finalMessageNewLine}`;

		logAsWarn ? this.warn(header, ...finalMessage) : this.debug(header, ...finalMessage);
	}

	private async createMissingCommand(
		commandsManager: ApplicationCommandManager,
		apiData: InternalAPICall['builtData'],
		type: string,
		guildId?: string
	) {
		try {
			const result = await commandsManager.create(apiData, guildId);

			this.info(
				`Successfully created ${type}${guildId ? ' guild' : ''} command "${apiData.name}" with id "${
					result.id
				}". You should add the id to the "idHints" property of the register method you used!`
			);

			switch (apiData.type) {
				case undefined:
				case ApplicationCommandType.ChatInput: {
					this.handleIdAddition(InternalRegistryAPIType.ChatInput, result.id, guildId);
					break;
				}
				case ApplicationCommandType.Message:
				case ApplicationCommandType.User: {
					this.handleIdAddition(InternalRegistryAPIType.ContextMenu, result.id, guildId);
					break;
				}
			}
		} catch (err) {
			this.error(
				`Failed to register${guildId ? ' guild' : ''} application command with name "${apiData.name}"${
					guildId ? ` for guild "${guildId}"` : ''
				}`,
				err
			);
		}
	}

	private info(message: string, ...other: unknown[]) {
		container.logger.info(`ApplicationCommandRegistry[${this.commandName}] ${message}`, ...other);
	}

	private error(message: string, ...other: unknown[]) {
		container.logger.error(`ApplicationCommandRegistry[${this.commandName}] ${message}`, ...other);
	}

	private warn(message: string, ...other: unknown[]) {
		container.logger.warn(`ApplicationCommandRegistry[${this.commandName}] ${message}`, ...other);
	}

	private debug(message: string, ...other: unknown[]) {
		container.logger.debug(`ApplicationCommandRegistry[${this.commandName}] ${message}`, ...other);
	}

	private trace(message: string, ...other: unknown[]) {
		container.logger.trace(`ApplicationCommandRegistry[${this.commandName}] ${message}`, ...other);
	}
}

export namespace ApplicationCommandRegistry {
	export interface RegisterOptions {
		/**
		 * If this is specified, the application commands will only be registered for these guild ids.
		 */
		guildIds?: string[];
		/**
		 * If we should register the command when it is missing
		 * @default true
		 */
		registerCommandIfMissing?: boolean;
		/**
		 * Specifies what we should do when the command is present, but not identical with the data you provided
		 * @default `ApplicationCommandRegistries.getDefaultBehaviorWhenNotIdentical()`
		 */
		behaviorWhenNotIdentical?: Exclude<RegisterBehavior, RegisterBehavior.BulkOverwrite>;
		/**
		 * Specifies a list of command ids that we should check in the event of a name mismatch
		 * @default []
		 */
		idHints?: string[];
	}
}

export type ApplicationCommandRegistryRegisterOptions = ApplicationCommandRegistry.RegisterOptions;

type InternalRegisterOptions = Omit<ApplicationCommandRegistry.RegisterOptions, 'behaviorWhenNotIdentical'> & {
	behaviorWhenNotIdentical?: RegisterBehavior;
};

export type InternalAPICall =
	| {
			builtData: RESTPostAPIChatInputApplicationCommandsJSONBody;
			registerOptions: InternalRegisterOptions;
			type: InternalRegistryAPIType.ChatInput;
	  }
	| {
			builtData: RESTPostAPIContextMenuApplicationCommandsJSONBody;
			registerOptions: InternalRegisterOptions;
			type: InternalRegistryAPIType.ContextMenu;
	  };
