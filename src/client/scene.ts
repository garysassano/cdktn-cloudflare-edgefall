import Phaser from "phaser";
import {
  type AnimationTag,
  type CompactSnapshot,
  type GameplayEvent,
  type InputFrame,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type PlayerState,
  type PrimaryWeaponId,
  type ProjectileKind,
} from "../game/protocol.js";

export interface PresentationSettings {
  contrast: boolean;
  flashes: boolean;
  reduceMotion: boolean;
  shake: boolean;
  volume: number;
}

interface PlayerVisual {
  body: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  upperBody: Phaser.GameObjects.Sprite;
  weapon: Phaser.GameObjects.Sprite;
}

interface EnemyVisual {
  body: Phaser.GameObjects.Sprite;
}

interface ProjectileVisual {
  body: Phaser.GameObjects.Sprite;
}

interface PulseState {
  ability: boolean;
  dodge: boolean;
  jump: boolean;
  melee: boolean;
  ordnance: boolean;
  reload: boolean;
}

type KeyMap = Record<
  "ability" | "crouch" | "dodge" | "jump" | "left" | "melee" | "ordnance" | "reload" | "right",
  Phaser.Input.Keyboard.Key
>;

const DEFAULT_SETTINGS: PresentationSettings = {
  contrast: false,
  flashes: true,
  reduceMotion: false,
  shake: true,
  volume: 0.7,
};

export class EdgefallScene extends Phaser.Scene {
  onInput?: (input: InputFrame) => void;
  private backgrounds: Phaser.GameObjects.Image[] = [];
  private bossMusic?: Phaser.Sound.BaseSound;
  private currentMusic: "biome" | "boss" | undefined;
  private enemies = new Map<string, EnemyVisual>();
  private flash!: Phaser.GameObjects.Rectangle;
  private keys!: KeyMap;
  private lighting!: Phaser.GameObjects.Graphics;
  private localPlayerId = "";
  private music?: Phaser.Sound.BaseSound;
  private players = new Map<string, PlayerVisual>();
  private predictedLocal?: PlayerState;
  private previousButtons: PulseState = {
    ability: false,
    dodge: false,
    jump: false,
    melee: false,
    ordnance: false,
    reload: false,
  };
  private projectiles = new Map<string, ProjectileVisual>();
  private sequence = 0;
  private settings: PresentationSettings = DEFAULT_SETTINGS;
  private snapshot?: CompactSnapshot;
  private world!: Phaser.GameObjects.Graphics;

  constructor() {
    super("edgefall");
  }

  preload(): void {
    this.load.image("railworks", "/assets/art/cinder-railworks.png");
    this.load.atlas(
      "benchmark",
      "/assets/art/rook-benchmark.png",
      "/assets/art/rook-benchmark.json",
    );
    for (const [key, file] of Object.entries(AUDIO_FILES))
      this.load.audio(key, `/assets/audio/${file}`);
  }

  create(): void {
    this.cameras.main.setRoundPixels(true);
    this.cameras.main.setBackgroundColor("#090808");
    this.registerAnimations();
    for (let index = 0; index < 8; index += 1) {
      const background = this.add
        .image(index * 900 + 450, 180, "railworks")
        .setDisplaySize(900, 506)
        .setScrollFactor(0.22, 0)
        .setDepth(0);
      this.backgrounds.push(background);
    }
    this.world = this.add.graphics().setDepth(4);
    this.lighting = this.add.graphics().setDepth(7).setBlendMode(Phaser.BlendModes.ADD);
    this.flash = this.add
      .rectangle(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT, 0xffb057, 0)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(50);
    this.keys = this.input.keyboard?.addKeys({
      ability: Phaser.Input.Keyboard.KeyCodes.E,
      crouch: Phaser.Input.Keyboard.KeyCodes.S,
      dodge: Phaser.Input.Keyboard.KeyCodes.SHIFT,
      jump: Phaser.Input.Keyboard.KeyCodes.SPACE,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      melee: Phaser.Input.Keyboard.KeyCodes.F,
      ordnance: Phaser.Input.Keyboard.KeyCodes.Q,
      reload: Phaser.Input.Keyboard.KeyCodes.R,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    }) as KeyMap;
    this.input.mouse?.disableContextMenu();
    this.time.addEvent({
      callback: () => {
        const input = this.sampleInput();
        this.predictLocalInput(input);
        this.onInput?.(input);
      },
      delay: 1_000 / 30,
      loop: true,
    });
  }

  update(_time: number, delta: number): void {
    if (!this.snapshot) return;
    const smoothing = Math.min(1, delta / 70);
    this.renderPlayers(smoothing);
    this.renderEnemies(smoothing);
    this.renderProjectiles(smoothing);
    this.drawLighting();
    if (!this.settings.reduceMotion) {
      for (const [index, background] of this.backgrounds.entries()) {
        background.y = 180 + Math.sin(this.time.now * 0.00018 + index) * 1.5;
      }
    }
  }

  applySnapshot(
    snapshot: CompactSnapshot,
    localPlayerId: string,
    pendingInputs: readonly InputFrame[],
  ): void {
    const previousPhase = this.snapshot?.phase;
    this.snapshot = snapshot;
    this.localPlayerId = localPlayerId;
    const authoritative = snapshot.players.find((player) => player.id === localPlayerId);
    if (authoritative) {
      this.predictedLocal = {
        ...authoritative,
        relics: [...authoritative.relics],
        mutations: [...authoritative.mutations],
      };
      for (const input of pendingInputs) this.applyHorizontalPrediction(this.predictedLocal, input);
    }
    this.drawWorld();
    this.syncMusic();
    if (previousPhase && previousPhase !== snapshot.phase && snapshot.phase === "reward") {
      this.sound.play("reward", { volume: 0.45 * this.settings.volume });
    }
  }

  playEvents(events: readonly GameplayEvent[]): void {
    for (const event of events) {
      if (event.type === "fire") this.presentFire(event);
      if (event.type === "hit") this.presentImpact(event, false);
      if (event.type === "player-hit") this.presentImpact(event, true);
      if (event.type === "melee") this.playSound("melee", 0.45);
      if (event.type === "dodge") this.presentDodge(event);
      if (event.type === "explosion" || event.type === "destructible-broken") {
        this.presentExplosion(event);
      }
      if (event.type === "boss-telegraph") this.presentTelegraph();
      if (event.type === "boss-component-broken") this.presentExplosion(event, 0x9b72ff);
      if (event.type === "revive" || event.type === "reentry") {
        this.spawnEffect("vfx-violet", event.x, event.y, 0x72e6c4, 0.45);
      }
    }
  }

  setPresentationSettings(settings: PresentationSettings): void {
    this.settings = settings;
    this.sound.volume = settings.volume;
  }

  private sampleInput(): InputFrame {
    const pad = this.input.gamepad?.getPad(0);
    const leftAxis = deadzone(pad?.axes[0]?.getValue() ?? 0);
    const verticalAxis = deadzone(pad?.axes[1]?.getValue() ?? 0);
    const rightAxisX = deadzone(pad?.axes[2]?.getValue() ?? 0);
    const rightAxisY = deadzone(pad?.axes[3]?.getValue() ?? 0);
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const player = this.predictedLocal;
    const pointerAimX = player ? worldPoint.x - player.x : 1;
    const pointerAimY = player ? worldPoint.y - (player.y - 22) : 0;
    const pointerLength = Math.hypot(pointerAimX, pointerAimY) || 1;
    const useStickAim = Math.hypot(rightAxisX, rightAxisY) > 0.18;
    const current: PulseState = {
      ability: this.keys.ability.isDown || Boolean(pad?.buttons[3]?.pressed),
      dodge: this.keys.dodge.isDown || Boolean(pad?.buttons[1]?.pressed),
      jump: this.keys.jump.isDown || Boolean(pad?.buttons[0]?.pressed),
      melee: this.keys.melee.isDown || Boolean(pad?.buttons[2]?.pressed),
      ordnance: this.keys.ordnance.isDown || Boolean(pad?.buttons[4]?.pressed),
      reload: this.keys.reload.isDown || Boolean(pad?.buttons[5]?.pressed),
    };
    const jump = pulse(current.jump, this.previousButtons.jump);
    const crouch =
      this.keys.crouch.isDown || verticalAxis > 0.45 || Boolean(pad?.buttons[13]?.pressed);
    const input: InputFrame = {
      ability: pulse(current.ability, this.previousButtons.ability),
      aimX: useStickAim ? rightAxisX : pointerAimX / pointerLength,
      aimY: useStickAim ? rightAxisY : pointerAimY / pointerLength,
      crouch,
      dodge: pulse(current.dodge, this.previousButtons.dodge),
      drop: crouch && jump,
      fire: pointer.leftButtonDown() || Boolean(pad?.buttons[7]?.pressed),
      jump,
      left: this.keys.left.isDown || leftAxis < -0.35 || Boolean(pad?.buttons[14]?.pressed),
      melee: pulse(current.melee, this.previousButtons.melee),
      ordnance: pulse(current.ordnance, this.previousButtons.ordnance),
      reload: pulse(current.reload, this.previousButtons.reload),
      right: this.keys.right.isDown || leftAxis > 0.35 || Boolean(pad?.buttons[15]?.pressed),
      sequence: this.sequence,
    };
    this.sequence += 1;
    this.previousButtons = current;
    return input;
  }

  private predictLocalInput(input: InputFrame): void {
    if (!this.predictedLocal || !this.snapshot || !["combat", "boss"].includes(this.snapshot.phase))
      return;
    this.applyHorizontalPrediction(this.predictedLocal, input);
    if (Math.abs(input.aimX) > 0.05) {
      this.predictedLocal.aimX = input.aimX;
      this.predictedLocal.aimY = input.aimY;
      this.predictedLocal.facing = input.aimX < 0 ? -1 : 1;
    }
  }

  private applyHorizontalPrediction(player: PlayerState, input: InputFrame): void {
    const move = Number(input.right) - Number(input.left);
    player.x = Phaser.Math.Clamp(
      player.x + (move * player.speed) / 30,
      this.snapshot?.module.startX ?? player.x,
      this.snapshot?.module.endX ?? player.x,
    );
  }

  private renderPlayers(smoothing: number): void {
    if (!this.snapshot) return;
    const active = new Set(this.snapshot.players.map((player) => player.id));
    for (const [id, visual] of this.players) {
      if (!active.has(id)) {
        visual.body.destroy();
        visual.upperBody.destroy();
        visual.weapon.destroy();
        visual.label.destroy();
        this.players.delete(id);
      }
    }
    for (const authoritative of this.snapshot.players) {
      const player =
        authoritative.id === this.localPlayerId && this.predictedLocal
          ? this.predictedLocal
          : authoritative;
      let visual = this.players.get(player.id);
      if (!visual) {
        visual = {
          body: this.add
            .sprite(player.x, player.y, "benchmark", "rook-idle-a")
            .setOrigin(0.5, 1)
            .setScale(0.43)
            .setDepth(12),
          label: this.add
            .text(player.x, player.y - 52, player.name, {
              color: player.color,
              fontFamily: "monospace",
              fontSize: "7px",
              stroke: "#000000",
              strokeThickness: 2,
            })
            .setOrigin(0.5)
            .setDepth(15),
          upperBody: this.add
            .sprite(player.x, player.y - 35, "benchmark", "rook-idle-a")
            .setCrop(0, 0, 110, 72)
            .setOrigin(0.5)
            .setScale(0.43)
            .setDepth(13),
          weapon: this.add
            .sprite(player.x, player.y - 23, "benchmark", weaponFrame(player.weapon.id))
            .setOrigin(0.18, 0.5)
            .setScale(0.22)
            .setDepth(14),
        };
        this.players.set(player.id, visual);
        if (player.id === this.localPlayerId) {
          this.cameras.main.setBounds(
            this.snapshot.module.startX,
            0,
            this.snapshot.module.endX - this.snapshot.module.startX,
            LOGICAL_HEIGHT,
          );
          this.cameras.main.startFollow(visual.body, true, 0.14, 0.14, 0, 34);
          this.cameras.main.setDeadzone(180, 82);
        }
      }
      const snap = player.id === this.localPlayerId ? 1 : smoothing;
      visual.body.x = Phaser.Math.Linear(visual.body.x, player.x, snap);
      visual.body.y = Phaser.Math.Linear(visual.body.y, player.y, snap);
      visual.body.setFlipX(player.facing < 0);
      visual.upperBody.setPosition(
        visual.body.x + player.aimX * 1.5,
        visual.body.y - (player.animation === "crouch" ? 25 : 38),
      );
      visual.upperBody.setFlipX(player.facing < 0);
      visual.upperBody.setRotation(Phaser.Math.Clamp(player.aimY * 0.12, -0.12, 0.12));
      visual.upperBody.setVisible(
        !player.downed &&
          player.reentryRemaining === 0 &&
          !["dodge", "hurt", "melee", "revive"].includes(player.animation),
      );
      const animation = animationKey(player.animation);
      if (visual.body.anims.currentAnim?.key !== animation) visual.body.play(animation, true);
      const playerAlpha = player.reentryRemaining > 0 ? 0 : player.invulnerable > 0 ? 0.65 : 1;
      visual.body.setAlpha(playerAlpha);
      visual.upperBody.setAlpha(playerAlpha);
      const baseTint =
        player.selection.outfit === "foundry"
          ? 0x9f8e84
          : player.selection.operator === "vale"
            ? 0xc8b8ff
            : undefined;
      for (const layer of [visual.body, visual.upperBody]) {
        layer.clearTint();
        if (baseTint !== undefined) layer.setTint(baseTint);
        if (this.settings.contrast) layer.setTint(colorNumber(player.color)).setTintFill();
      }
      visual.weapon.setFrame(weaponFrame(player.weapon.id));
      visual.weapon.x = visual.body.x + player.aimX * 8;
      visual.weapon.y = visual.body.y - (player.animation === "crouch" ? 14 : 25);
      visual.weapon.setRotation(Math.atan2(player.aimY, player.aimX));
      visual.weapon.setFlipY(player.aimX < 0);
      visual.weapon.setVisible(!player.downed && player.reentryRemaining === 0);
      visual.label
        .setPosition(visual.body.x, visual.body.y - 54)
        .setVisible(player.reentryRemaining === 0);
    }
  }

  private renderEnemies(smoothing: number): void {
    if (!this.snapshot) return;
    const active = new Set(this.snapshot.enemies.map((enemy) => enemy.id));
    for (const [id, visual] of this.enemies) {
      if (!active.has(id)) {
        visual.body.destroy();
        this.enemies.delete(id);
      }
    }
    for (const enemy of this.snapshot.enemies) {
      let visual = this.enemies.get(enemy.id);
      if (!visual) {
        visual = {
          body: this.add
            .sprite(enemy.x, enemy.y, "benchmark", "enemy-shield-a")
            .setOrigin(0.5, 1)
            .setScale(
              enemy.kind === "kilnheart" ? 0.82 : enemy.kind === "slag-warden" ? 0.48 : 0.33,
            )
            .setDepth(11)
            .setTint(ENEMY_TINTS[enemy.kind]),
        };
        this.enemies.set(enemy.id, visual);
      }
      visual.body.x = Phaser.Math.Linear(visual.body.x, enemy.x, smoothing);
      visual.body.y = Phaser.Math.Linear(visual.body.y, enemy.y, smoothing);
      visual.body.setFlipX(enemy.facing > 0);
      const animation = enemy.mode === "attack" ? "enemy-attack" : "enemy-idle";
      if (visual.body.anims.currentAnim?.key !== animation) visual.body.play(animation, true);
      visual.body.clearTint();
      if (enemy.mode === "telegraph") visual.body.setTint(0xff5a32).setTintFill();
      else visual.body.setTint(ENEMY_TINTS[enemy.kind]);
    }
  }

  private renderProjectiles(smoothing: number): void {
    if (!this.snapshot) return;
    const active = new Set(this.snapshot.projectiles.map((projectile) => projectile.id));
    for (const [id, visual] of this.projectiles) {
      if (!active.has(id)) {
        visual.body.destroy();
        this.projectiles.delete(id);
      }
    }
    for (const projectile of this.snapshot.projectiles) {
      let visual = this.projectiles.get(projectile.id);
      if (!visual) {
        const presentation = PROJECTILE_PRESENTATION[projectile.kind];
        visual = {
          body: this.add
            .sprite(projectile.x, projectile.y, "benchmark", presentation.frame)
            .setScale(presentation.scale)
            .setTint(presentation.tint)
            .setDepth(13),
        };
        this.projectiles.set(projectile.id, visual);
      }
      visual.body.x = Phaser.Math.Linear(visual.body.x, projectile.x, smoothing);
      visual.body.y = Phaser.Math.Linear(visual.body.y, projectile.y, smoothing);
      visual.body.setRotation(Math.atan2(projectile.vy, projectile.vx));
    }
  }

  private drawWorld(): void {
    if (!this.snapshot || !this.world) return;
    this.world.clear();
    for (const platform of this.snapshot.platforms) {
      if (platform.y > 380) continue;
      this.world.fillStyle(platform.collapsing ? 0x7a3928 : 0x3c3734, 0.95);
      this.world.fillRect(platform.x, platform.y, platform.w, platform.h);
      this.world.lineStyle(1, platform.oneWay ? 0xc27842 : 0x786b60, 0.9);
      this.world.strokeRect(platform.x, platform.y, platform.w, Math.min(platform.h, 6));
    }
    for (const hazard of this.snapshot.hazards) {
      if (!hazard.active) continue;
      this.world.fillStyle(
        hazard.kind === "steam" ? 0xe2d6c8 : 0xff5a20,
        hazard.kind === "steam" ? 0.2 : 0.62,
      );
      this.world.fillRect(hazard.x, hazard.y, hazard.w, hazard.h);
    }
    for (const object of this.snapshot.destructibles) {
      if (object.destroyed) continue;
      this.world.fillStyle(object.kind === "barrel" ? 0x9a4929 : 0x5a4434, 1);
      this.world.fillRect(object.x, object.y, object.w, object.h);
      this.world.lineStyle(1, 0xffa35a, 0.7);
      this.world.strokeRect(object.x, object.y, object.w, object.h);
    }
    for (const component of this.snapshot.bossComponents) {
      if (component.broken) continue;
      this.world.fillStyle(0xff8b35, 0.82);
      this.world.fillCircle(component.x, component.y, 13);
      this.world.lineStyle(2, 0xffe0a2, 1);
      this.world.strokeCircle(component.x, component.y, 17);
    }
    const boss = this.snapshot.enemies.find((enemy) => enemy.kind === "kilnheart");
    if (boss?.mode === "telegraph") {
      this.world.fillStyle(0xff314b, 0.18);
      this.world.fillRect(boss.x - 230, 285, 460, 43);
      this.world.lineStyle(2, 0xff6b58, 0.9);
      this.world.strokeRect(boss.x - 230, 285, 460, 43);
    }
  }

  private drawLighting(): void {
    if (!this.snapshot) return;
    this.lighting.clear();
    const pulse = 0.06 + Math.sin(this.time.now * 0.004) * 0.02;
    for (const hazard of this.snapshot.hazards.filter(
      (candidate) => candidate.kind === "molten" && candidate.active,
    )) {
      this.lighting.fillStyle(0xff5a20, pulse);
      this.lighting.fillCircle(hazard.x + hazard.w / 2, hazard.y, hazard.w * 0.72);
    }
    for (const component of this.snapshot.bossComponents.filter((candidate) => !candidate.broken)) {
      this.lighting.fillStyle(0xff9a3c, pulse * 1.4);
      this.lighting.fillCircle(component.x, component.y, 38);
    }
  }

  private presentFire(event: GameplayEvent): void {
    const weapon = event.kind as PrimaryWeaponId | undefined;
    if (!weapon) return;
    this.playSound(WEAPON_SOUNDS[weapon], weapon === "beam" ? 0.25 : 0.38);
    const tint = WEAPON_FLASH[weapon];
    this.spawnEffect("vfx-muzzle", event.x, event.y, tint, weapon === "scattergun" ? 0.42 : 0.3);
    this.spawnEffect("vfx-casing", event.x - 4, event.y + 2, 0xffc35c, 0.18, true);
    if (this.settings.shake) {
      const strength = weapon === "rivet-launcher" || weapon === "scattergun" ? 0.006 : 0.0025;
      this.cameras.main.shake(55, strength);
    }
  }

  private presentImpact(event: GameplayEvent, playerHit: boolean): void {
    this.playSound(playerHit ? "player-hit" : "impact-light", playerHit ? 0.5 : 0.22);
    this.spawnEffect("vfx-impact", event.x, event.y, playerHit ? 0xff465d : 0xffa24d, 0.24);
    if (playerHit && this.settings.shake) this.cameras.main.shake(90, 0.008);
  }

  private presentDodge(event: GameplayEvent): void {
    this.playSound("dodge", 0.32);
    this.spawnEffect("vfx-violet", event.x, event.y, 0x9b72ff, 0.45);
  }

  private presentExplosion(event: GameplayEvent, tint = 0xff752f): void {
    this.playSound("explosion", 0.55);
    this.spawnEffect("vfx-explosion", event.x, event.y, tint, 0.62);
    this.spawnEffect("vfx-smoke", event.x, event.y - 6, 0x99877c, 0.45);
    if (this.settings.shake) this.cameras.main.shake(180, 0.015);
    if (this.settings.flashes) this.flashScreen(tint, 0.16);
  }

  private presentTelegraph(): void {
    if (this.settings.flashes) this.flashScreen(0xff304a, 0.1);
    if (this.settings.shake) this.cameras.main.shake(120, 0.004);
  }

  private spawnEffect(
    frame: string,
    x: number,
    y: number,
    tint: number,
    scale: number,
    debris = false,
  ): void {
    const effect = this.add
      .sprite(x, y, "benchmark", frame)
      .setScale(scale)
      .setTint(tint)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(30);
    this.tweens.add({
      alpha: 0,
      duration: debris ? 420 : 210,
      ease: "Quad.easeOut",
      onComplete: () => effect.destroy(),
      rotation: debris ? 2.4 : 0,
      targets: effect,
      x: debris ? x - 13 : x,
      y: debris ? y + 18 : y,
    });
  }

  private flashScreen(tint: number, alpha: number): void {
    this.flash.setFillStyle(tint, alpha);
    this.tweens.killTweensOf(this.flash);
    this.tweens.add({ alpha: 0, duration: 140, targets: this.flash });
  }

  private playSound(key: string, volume: number): void {
    if (this.cache.audio.exists(key))
      this.sound.play(key, { volume: volume * this.settings.volume });
  }

  private syncMusic(): void {
    if (!this.snapshot || this.settings.volume === 0) return;
    const desired = this.snapshot.phase === "boss" ? "boss" : "biome";
    if (this.currentMusic === desired) return;
    this.music?.stop();
    this.bossMusic?.stop();
    if (desired === "boss") {
      this.bossMusic = this.sound.add("boss-loop", {
        loop: true,
        volume: 0.18 * this.settings.volume,
      });
      this.bossMusic.play();
    } else {
      this.music = this.sound.add("biome-loop", {
        loop: true,
        volume: 0.14 * this.settings.volume,
      });
      this.music.play();
    }
    this.currentMusic = desired;
  }

  private registerAnimations(): void {
    for (const [key, frames] of Object.entries(PLAYER_ANIMATIONS)) {
      if (this.anims.exists(key)) continue;
      this.anims.create({
        frameRate: key === "rook-run" ? 11 : 6,
        frames: frames.map((frame) => ({ frame, key: "benchmark" })),
        key,
        repeat: ["rook-idle", "rook-run", "rook-downed"].includes(key) ? -1 : 0,
      });
    }
    this.anims.create({
      frameRate: 5,
      frames: ["enemy-shield-a", "enemy-shield-b", "enemy-shield-c"].map((frame) => ({
        frame,
        key: "benchmark",
      })),
      key: "enemy-idle",
      repeat: -1,
    });
    this.anims.create({
      frameRate: 9,
      frames: ["enemy-shield-d", "enemy-shield-e", "enemy-shield-f"].map((frame) => ({
        frame,
        key: "benchmark",
      })),
      key: "enemy-attack",
      repeat: 0,
    });
  }
}

const AUDIO_FILES = {
  "beam-loop": "beam-loop.ogg",
  "biome-loop": "biome-loop.ogg",
  "boss-loop": "boss-loop.ogg",
  "carbine-shot": "carbine-shot.ogg",
  dodge: "dodge.ogg",
  explosion: "explosion.ogg",
  "footstep-a": "footstep-a.ogg",
  "footstep-b": "footstep-b.ogg",
  "impact-light": "impact-light.ogg",
  melee: "melee.ogg",
  "player-hit": "player-hit.ogg",
  reward: "reward.ogg",
  "rivet-shot": "rivet-shot.ogg",
  "scatter-shot": "scatter-shot.ogg",
  victory: "victory.ogg",
} as const;

const PLAYER_ANIMATIONS: Record<string, string[]> = {
  "rook-ability": ["rook-idle-a", "rook-fire", "rook-idle-c"],
  "rook-crouch": ["rook-crouch"],
  "rook-dodge": ["rook-dodge"],
  "rook-downed": ["rook-downed-a", "rook-downed-b"],
  "rook-fall": ["rook-jump"],
  "rook-fire": ["rook-fire", "rook-idle-c"],
  "rook-hurt": ["rook-hurt"],
  "rook-idle": ["rook-idle-a", "rook-idle-b", "rook-idle-c", "rook-idle-b"],
  "rook-jump": ["rook-jump"],
  "rook-land": ["rook-crouch", "rook-idle-a"],
  "rook-melee": ["rook-melee", "rook-idle-a"],
  "rook-reload": ["rook-reload", "rook-idle-c"],
  "rook-revive": ["rook-revive", "rook-idle-a"],
  "rook-run": ["rook-run-a", "rook-run-b", "rook-run-c", "rook-run-d"],
  "rook-run-start": ["rook-idle-a", "rook-run-a"],
  "rook-run-stop": ["rook-run-d", "rook-idle-a"],
  "rook-victory": ["rook-idle-c", "rook-fire"],
};

const ENEMY_TINTS = {
  drone: 0xb6a7ff,
  grenadier: 0xe0aa65,
  kilnheart: 0xff662f,
  rifleman: 0xd6c4a2,
  rusher: 0xff8165,
  shieldbearer: 0xb9a779,
  "slag-warden": 0xffb242,
} as const;

const PROJECTILE_PRESENTATION: Record<
  ProjectileKind,
  { frame: string; scale: number; tint: number }
> = {
  beam: { frame: "vfx-tracer", scale: 0.19, tint: 0x9b72ff },
  "boss-fire": { frame: "vfx-muzzle", scale: 0.12, tint: 0xff3655 },
  bullet: { frame: "vfx-tracer", scale: 0.08, tint: 0xffdc81 },
  "enemy-bullet": { frame: "vfx-tracer", scale: 0.07, tint: 0xff4b63 },
  grenade: { frame: "vfx-impact", scale: 0.09, tint: 0xff7135 },
  mine: { frame: "vfx-impact", scale: 0.08, tint: 0x72e6c4 },
  pellet: { frame: "vfx-tracer", scale: 0.055, tint: 0xfff0bc },
  rivet: { frame: "vfx-impact", scale: 0.09, tint: 0xff9c3d },
};

const WEAPON_SOUNDS: Record<PrimaryWeaponId, string> = {
  beam: "beam-loop",
  carbine: "carbine-shot",
  "rivet-launcher": "rivet-shot",
  scattergun: "scatter-shot",
};

const WEAPON_FLASH: Record<PrimaryWeaponId, number> = {
  beam: 0x9b72ff,
  carbine: 0xffc66c,
  "rivet-launcher": 0xff6a2f,
  scattergun: 0xfff0be,
};

function weaponFrame(weapon: PrimaryWeaponId): string {
  return `weapon-${weapon === "rivet-launcher" ? "rivet" : weapon}`;
}

function animationKey(animation: AnimationTag): string {
  const key = `rook-${animation}`;
  return PLAYER_ANIMATIONS[key] ? key : "rook-idle";
}

function colorNumber(color: string): number {
  return Phaser.Display.Color.HexStringToColor(color).color;
}

function pulse(current: boolean, previous: boolean): boolean {
  return current && !previous;
}

function deadzone(value: number): number {
  return Math.abs(value) < 0.16 ? 0 : Phaser.Math.Clamp(value, -1, 1);
}
