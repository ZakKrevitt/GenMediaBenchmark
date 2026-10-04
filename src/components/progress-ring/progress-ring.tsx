'use client';

import { useEffect } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { motionTokens } from '../arc/lib/motion-tokens';
import styles from './progress-ring.module.css';

// Arc ships a linear Progress but no circular one, so this ring follows its tokens: the same
// accent fill over a muted track, one spring for fill and count, and success on completion.
export interface ProgressRingProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** 0-100. Leave null or undefined when the work has no measurable progress: the ring spins. */
  value?: number | null;
  /** sm sits inline with text, md shows the count inside, lg is for empty media frames. */
  size?: 'sm' | 'md' | 'lg';
  label: string;
}

const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ProgressRing({
  value,
  size = 'sm',
  label,
  className,
  ...props
}: ProgressRingProps) {
  const reduce = useReducedMotion();
  const known = typeof value === 'number' && Number.isFinite(value);
  const percent = known ? Math.min(100, Math.max(0, value)) : 0;
  const progress = useMotionValue(percent);
  const offset = useTransform(
    progress,
    (p) => CIRCUMFERENCE * (1 - Math.min(Math.max(p, 0), 100) / 100),
  );
  const counted = useTransform(progress, (p) => `${Math.round(Math.min(Math.max(p, 0), 100))}%`);
  useEffect(() => {
    if (reduce) {
      progress.jump(percent);
      return;
    }
    const controls = animate(progress, percent, motionTokens.spring.smooth);
    return () => controls.stop();
  }, [percent, progress, reduce]);
  const classes = [styles.ring, styles[size], className].filter(Boolean).join(' ');
  return (
    <span
      {...props}
      className={classes}
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? Math.round(percent) : undefined}
      data-indeterminate={known ? undefined : ''}
      data-complete={known && percent >= 100 ? '' : undefined}
    >
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle className={styles.track} cx="22" cy="22" r={RADIUS} />
        {known ? (
          <motion.circle
            className={styles.fill}
            cx="22"
            cy="22"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            style={{ strokeDashoffset: offset }}
          />
        ) : (
          <circle
            className={`${styles.fill} ${styles.spin}`}
            cx="22"
            cy="22"
            r={RADIUS}
            strokeDasharray={`${CIRCUMFERENCE * 0.28} ${CIRCUMFERENCE}`}
          />
        )}
      </svg>
      {known && size !== 'sm' ? (
        <motion.span className={styles.count} aria-hidden="true">
          {counted}
        </motion.span>
      ) : null}
    </span>
  );
}

/** A ring with a line of status text beside it, for panels and rows. */
export function ProgressStatus({
  value,
  label,
  detail,
  size = 'sm',
  className,
}: {
  value?: number | null;
  label: string;
  detail?: React.ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <p className={[styles.status, className].filter(Boolean).join(' ')} role="status">
      <ProgressRing value={value} size={size} label={label} />
      <span className={styles.statusText}>
        <span className={styles.statusLabel}>{label}</span>
        {detail ? <span className={styles.detail}>{detail}</span> : null}
      </span>
    </p>
  );
}

export default ProgressRing;
