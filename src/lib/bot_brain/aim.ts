// The aim tracker: settings_PC.txt's `aiming.*` block, run as a
// spring-damper on the pitch and yaw axes.
//
// Each axis carries an angular velocity. Every frame the spring pulls the
// view toward the ideal angle with `spring_stiffness` and bleeds that pull
// with `damping`:
//
//     accel    = stiffness * error - damping * velocity
//     velocity = clamp(velocity + accel * dt, +/- max_acceleration)
//     angle    = angle + velocity * dt
//
// READING `aiming.max_acceleration`. The retail comment calls it "max angle
// acceleration allowed per second", but the six shipped values (180, 225,
// 315, 360, 480, 720) only make a coherent skill ladder when they clamp the
// view's angular SPEED in degrees per second, not its acceleration. As a
// speed clamp, practice needs half a second to swing 90 degrees and
// nightmare needs an eighth of one -- the intended spread. As an
// acceleration clamp, the same six values give 1.41s and 0.71s: nightmare
// would aim barely twice as fast as practice, and the five other tuned
// `aiming.*` keys would have almost no effect, because the clamp would
// dominate every one of them (the spring wants 3600 deg/s^2 for a
// 90-degree error at the softest stiffness, twenty times the softest
// clamp). Clamped as a speed, the spring stays in charge and the six
// stiffness/damping pairs produce the six distinct settling behaviours they
// were obviously tuned for: damping ratios of 0.40, 0.65, 0.84, 0.89, 0.79
// and 0.67 against natural frequencies of 6.3 to 22.4 rad/s. This is the
// one place in the brain where a shipped comment is read against its
// literal wording, and it is called out here rather than left silent.
//
// `aiming.velocity_offset` is in seconds and is applied to the TARGET, not
// the view: the tracker aims where the target will be (or was) that many
// seconds from now. It is negative for every skill below expert -- the
// shipped comment's own "a negative number lags the target" -- and only
// nightmare leads at +0.1.
//
// The modifier window is a catch-up mode: when the angular error exceeds
// `modifier.max_angle`, the three `modifier.*_scalar` values multiply
// acceleration, stiffness and damping for `modifier.apply_time` seconds.

import type { BotAimingSettings } from "../botdata";
import { angleDelta, angleMod, bvecMA, clamp, vectorToAngles, type BotVec3 } from "./math";

export interface BotAimStateT {
  pitch: number;
  yaw: number;
  pitchVelocity: number;
  yawVelocity: number;
  /** Server time the modifier window expires; <= 0 when it is not running. */
  modifierUntil: number;
}

export function newAimState(pitch = 0, yaw = 0): BotAimStateT {
  return { pitch, yaw, pitchVelocity: 0, yawVelocity: 0, modifierUntil: 0 };
}

/** The point the tracker should be pulling toward, with `velocity_offset` already applied. */
export function aimLeadPoint(target: BotVec3, targetVelocity: BotVec3, settings: BotAimingSettings): BotVec3 {
  if (settings.velocityOffset === 0) return target;
  return bvecMA(target, settings.velocityOffset, targetVelocity);
}

/**
 * Advances the tracker one frame toward `idealDir` (a direction from the
 * bot's eye, not a point) and returns the new pitch and yaw.
 */
export function aimStep(state: BotAimStateT, idealDir: BotVec3, settings: BotAimingSettings, dt: number, now: number): { pitch: number; yaw: number } {
  if (dt <= 0) return { pitch: state.pitch, yaw: state.yaw };

  const ideal = vectorToAngles(idealDir);
  const pitchError = angleDelta(state.pitch, ideal.pitch);
  const yawError = angleDelta(state.yaw, ideal.yaw);

  // Open the catch-up window when either axis is further off than the
  // skill's max_angle. apply_time of 0 disables it, which is what the
  // shipped comment says.
  const worst = Math.max(Math.abs(pitchError), Math.abs(yawError));
  if (settings.modifierApplyTime > 0 && settings.modifierMaxAngle > 0 && worst > settings.modifierMaxAngle) {
    state.modifierUntil = now + settings.modifierApplyTime;
  }
  const modified = state.modifierUntil > now;

  const maxSpeed = settings.maxAcceleration * (modified ? settings.modifierAccelScalar : 1);
  const stiffness = settings.springStiffness * (modified ? settings.modifierSpringScalar : 1);
  const damping = settings.damping * (modified ? settings.modifierDampingScalar : 1);

  // The integrator is semi-implicit Euler, and it is substepped. A server
  // frame is 0.05s, and nightmare's spring (stiffness 500, doubled to 1000
  // inside the modifier window) has a natural frequency of 32 rad/s -- less
  // than six samples per oscillation at 20Hz, which rings instead of
  // settling. Splitting the frame so that no substep exceeds a quarter
  // radian of phase makes the tracker stable at every stiffness the shipped
  // data uses, and makes it frame-rate independent as a bonus: the same
  // 0.05s of simulation lands in the same place whether the host ran it as
  // one frame or four.
  const omega = Math.sqrt(Math.max(stiffness, 1));
  const substeps = Math.max(1, Math.min(64, Math.ceil((dt * omega) / 0.25)));
  const h = dt / substeps;

  const advance = (angle: number, velocity: number, errorTo: number): { angle: number; velocity: number } => {
    let a = angle;
    let v = velocity;
    for (let i = 0; i < substeps; i++) {
      const error = errorTo - (a - angle);
      const accel = stiffness * error - damping * v;
      v += accel * h;
      if (maxSpeed > 0) v = clamp(v, -maxSpeed, maxSpeed);
      a += v * h;
    }
    return { angle: a, velocity: v };
  };

  const p = advance(state.pitch, state.pitchVelocity, pitchError);
  const y = advance(state.yaw, state.yawVelocity, yawError);

  // Pitch is clamped to the range a Quake view can hold; yaw wraps.
  state.pitch = clamp(p.angle, -80, 80);
  state.pitchVelocity = state.pitch === p.angle ? p.velocity : 0;
  state.yaw = angleMod(y.angle);
  state.yawVelocity = y.velocity;

  return { pitch: state.pitch, yaw: state.yaw };
}

/** How far off the tracker still is from `idealDir`, in degrees. */
export function aimError(state: BotAimStateT, idealDir: BotVec3): number {
  const ideal = vectorToAngles(idealDir);
  return Math.max(Math.abs(angleDelta(state.pitch, ideal.pitch)), Math.abs(angleDelta(state.yaw, ideal.yaw)));
}
