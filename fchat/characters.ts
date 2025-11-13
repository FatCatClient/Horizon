import core from '../chat/core';
import { methods } from '../site/character_page/data_store';
import { decodeHTML } from './common';
import { Character as Interfaces, Connection } from './interfaces';
import { Character as CharacterProfile } from '../site/character_page/interfaces';
import Vue from 'vue';

class Character implements Interfaces.Character {
  gender: Interfaces.Gender = 'None';
  status: Interfaces.Status = 'offline';
  statusText = '';
  isFriend = false;
  isBookmarked = false;
  isChatOp = false;
  isIgnored = false;
  overrides: CharacterOverrides = {};
  previousStatusText = '';

  constructor(public name: string) {}

  hasStatusTextChanged(): boolean {
    return this.previousStatusText !== this.statusText;
  }
}

export interface CharacterOverrides {
  avatarUrl?: string;
  characterColor?: CharacterColor;
  gender?: Interfaces.Gender;
  status?: Interfaces.Status;
}

export enum CharacterColor {
  red,
  orange,
  yellow,
  green,
  cyan,
  purple,
  blue,
  pink,
  black,
  brown,
  white,
  gray,
  none
}

class State implements Interfaces.State {
  characters: { [key: string]: Character | undefined } = {};

  ownCharacter: Character = <any>undefined; /*tslint:disable-line:no-any*/ //hack
  ownProfile: CharacterProfile = <any>undefined; /*tslint:disable-line:no-any*/ //hack

  friends: Character[] = [];
  characterFriends: Character[] = [];
  bookmarks: Character[] = [];
  ignoreList: string[] = [];
  opList: string[] = [];
  friendList: string[] = [];
  characterFriendList: string[] = [];
  bookmarkList: string[] = [];

  get(name: string): Character {
    const key = name.toLowerCase();
    let char = this.characters[key];
    if (char === undefined) {
      char = new Character(name);
      char.isFriend = this.friendList.indexOf(name) !== -1;
      char.isBookmarked = this.bookmarkList.indexOf(name) !== -1;
      char.isChatOp = this.opList.indexOf(name) !== -1;
      char.isIgnored = this.ignoreList.indexOf(key) !== -1;
      this.characters[key] = char;
    }
    return char;
  }

  setStatus(
    character: Character,
    status: Interfaces.Status,
    text: string
  ): void {
    if (character.status === 'offline' && status !== 'offline') {
      if (character.isFriend) this.friends.push(character);
      if (character.isBookmarked) this.bookmarks.push(character);
    } else if (status === 'offline' && character.status !== 'offline') {
      if (character.isFriend)
        this.friends.splice(this.friends.indexOf(character), 1);
      if (character.isBookmarked)
        this.bookmarks.splice(this.bookmarks.indexOf(character), 1);
    }
    character.status = status;
    character.statusText = decodeHTML(text);
  }

  setOverride(name: string, type: 'avatarUrl', value: string | undefined): void;
  setOverride(
    name: string,
    type: 'gender',
    value: Interfaces.Gender | undefined
  ): void;
  setOverride(
    name: string,
    type: 'status',
    value: Interfaces.Status | undefined
  ): void;
  setOverride(
    name: string,
    type: 'characterColor',
    value: string | undefined | null
  ): void;
  setOverride(name: string, type: keyof CharacterOverrides, value: any): void {
    const char = this.get(name);
    let newValue: any;

    if (type === 'characterColor') {
      if (value === 'none' || value === undefined || value === null) {
        newValue = CharacterColor.none;
      } else {
        // This will work well, provided the bbcode colors never get expanded.
        // Funny joke. we all know they won't.
        const colorKey = value.toLowerCase() as keyof typeof CharacterColor;
        newValue =
          CharacterColor[colorKey] !== undefined
            ? CharacterColor[colorKey]
            : CharacterColor.none;
      }
    } else {
      newValue = value;
    }

    if (char.overrides[type] === newValue) {
      return;
    }

    Vue.set(char.overrides, type, newValue);
  }
  async refreshFriends(showPerCharacterFriends: boolean): Promise<void> {
    // Always fetch global friends
    this.friendList = (
      await core.connection.queryApi<{
        friends: { source: string; dest: string; last_online: number }[];
      }>('friend-list.php')
    ).friends.map(x => x.dest);

    this.friends = [
      ...new Set(
        this.friendList
          .map(x => state.get(x))
          .filter(x => x.status !== 'offline')
      )
    ]; //deduplicate apparently this is performant

    // If per-character friends is enabled, also fetch character-specific friends
    if (showPerCharacterFriends) {
      const id = this.ownProfile.character.id;
      this.characterFriendList = (
        await core.connection.queryApi<{
          friends: Character[];
        }>('character-friends.php', { id })
      ).friends.map(x => x.name);

      this.characterFriends = [
        ...new Set(
          this.characterFriendList
            .map(x => state.get(x))
            .filter(x => x.status !== 'offline')
        )
      ];
    } else {
      this.characterFriendList = [];
      this.characterFriends = [];
    }

    for (const key in state.characters) {
      const character = state.characters[key]!;
      character.isFriend = state.friendList.indexOf(character.name) !== -1;
    }
  }

  async resolveOwnProfile(): Promise<void> {
    await methods.fieldsGet();

    this.ownProfile = await methods.characterData(
      this.ownCharacter.name,
      -1,
      false
    );
  }
}

let state: State;

export default function (this: void, connection: Connection): Interfaces.State {
  state = new State();
  let reconnectStatus: Connection.ClientCommands['STA'];
  connection.onEvent('connecting', async isReconnect => {
    state.friends = [];
    state.bookmarks = [];
    state.bookmarkList = (
      await connection.queryApi<{ characters: string[] }>('bookmark-list.php')
    ).characters;
    state.friendList = (
      await connection.queryApi<{
        friends: { source: string; dest: string; last_online: number }[];
      }>('friend-list.php')
    ).friends.map(x => x.dest);
    if (isReconnect && <Character | undefined>state.ownCharacter !== undefined)
      reconnectStatus = {
        status: state.ownCharacter.status,
        statusmsg: state.ownCharacter.statusText
      };
    for (const key in state.characters) {
      const character = state.characters[key]!;
      character.isFriend = state.friendList.indexOf(character.name) !== -1;
      character.isBookmarked =
        state.bookmarkList.indexOf(character.name) !== -1;
      character.status = 'offline';
      character.statusText = '';
    }
  });
  connection.onEvent('connected', async isReconnect => {
    state.refreshFriends(core.state.settings.showPerCharacterFriends);
    if (!isReconnect) return;
    connection.send('STA', reconnectStatus);
    for (const key in state.characters) {
      const char = state.characters[key]!;
      char.isIgnored = state.ignoreList.indexOf(key) !== -1;
      char.isChatOp = state.opList.indexOf(char.name) !== -1;
    }
  });
  connection.onMessage('IGN', data => {
    switch (data.action) {
      case 'init':
        state.ignoreList = data.characters.slice();
        break;
      case 'add':
        state.ignoreList.push(data.character.toLowerCase());
        state.get(data.character).isIgnored = true;
        break;
      case 'delete':
        state.ignoreList.splice(
          state.ignoreList.indexOf(data.character.toLowerCase()),
          1
        );
        state.get(data.character).isIgnored = false;
    }
  });
  connection.onMessage('ADL', data => {
    state.opList = data.ops.slice();
  });
  connection.onMessage('LIS', data => {
    for (const char of data.characters) {
      const character = state.get(char[0]);
      character.gender = char[1];
      state.setStatus(character, char[2], char[3]);
    }
  });
  connection.onMessage('FLN', data => {
    //Going offline counts as changing status too for the previous status var
    let char = state.get(data.character);
    char.previousStatusText = char.statusText;
    state.setStatus(char, 'offline', '');
  });
  connection.onMessage('NLN', async data => {
    const character = state.get(data.identity);

    if (data.identity === connection.character) {
      state.ownCharacter = character;

      await state.resolveOwnProfile();

      // tslint:disable-next-line no-unnecessary-type-assertion
      core.cache.setProfile(state.ownProfile as CharacterProfile);
    }

    character.name = data.identity;
    character.gender = data.gender;
    state.setStatus(character, data.status, '');
  });
  connection.onMessage('STA', data => {
    //This is so it won't clear the previous status when their client reconnects and sends a STA message
    let char = state.get(data.character);
    if (char.statusText.length > 0 && data.statusmsg.length > 0) {
      char.previousStatusText = char.statusText;
    }
    state.setStatus(char, data.status, data.statusmsg);
  });
  connection.onMessage('AOP', data => {
    state.opList.push(data.character);
    const char = state.get(data.character);
    char.isChatOp = true;
  });
  connection.onMessage('DOP', data => {
    state.opList.splice(state.opList.indexOf(data.character), 1);
    const char = state.get(data.character);
    char.isChatOp = false;
  });
  connection.onMessage('RTB', async data => {
    console.log('got rtb:', data);
    if (
      data.type !== 'trackadd' &&
      data.type !== 'trackrem' &&
      data.type !== 'friendadd' &&
      data.type !== 'friendremove'
    )
      return;
    const character = state.get(data.name);
    const id = state.ownProfile.character.id;
    switch (data.type) {
      case 'trackadd':
        state.bookmarkList.push(data.name);
        character.isBookmarked = true;
        if (character.status !== 'offline') state.bookmarks.push(character);
        break;
      case 'trackrem':
        state.bookmarkList.splice(state.bookmarkList.indexOf(data.name), 1);
        character.isBookmarked = false;
        if (character.status !== 'offline')
          state.bookmarks.splice(state.bookmarks.indexOf(character), 1);
        break;
      case 'friendadd':
        // Always add to global friends
        state.friendList.push(data.name);
        character.isFriend = true;
        if (character.status !== 'offline') state.friends.push(character);

        // If per-character friends is enabled, also update that list
        if (core.state.settings.showPerCharacterFriends) {
          state.characterFriendList = (
            await connection.queryApi<{
              friends: Character[];
            }>('character-friends.php', { id })
          ).friends.map(x => x.name);

          state.characterFriends = [
            ...new Set(
              state.characterFriendList
                .map(x => state.get(x))
                .filter(x => x.status !== 'offline')
            )
          ];
        }
        break;
      case 'friendremove':
        // Always remove from global friends
        state.friendList.splice(state.friendList.indexOf(data.name), 1);
        character.isFriend = false;
        if (character.status !== 'offline') {
          state.friends.splice(state.friends.indexOf(character), 1);
        }

        // If per-character friends is enabled, also update that list
        if (core.state.settings.showPerCharacterFriends) {
          state.characterFriendList = (
            await connection.queryApi<{
              friends: Character[];
            }>('character-friends.php', { id })
          ).friends.map(x => x.name);

          state.characterFriends = [
            ...new Set(
              state.characterFriendList
                .map(x => state.get(x))
                .filter(x => x.status !== 'offline')
            )
          ];
        }
    }
  });
  return state;
}
