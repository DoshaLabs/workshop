import { describe, expect, it } from 'vitest'
import { projectName } from '@shared/sessions'

describe('projectName', () => {
  it('is the folder for an ordinary or a Claude Code worktree session', () => {
    expect(projectName('/Users/a/code/workshop')).toBe('workshop')
    expect(projectName('/Users/a/code/workshop/')).toBe('workshop')
  })
  it('drops the worktree a session started inside', () => {
    expect(projectName('/Users/a/code/workshop/.workshop/worktrees/fix-login')).toBe('workshop')
    expect(projectName('/Users/a/code/workshop/.claude/worktrees/quiet-brewing-possum/')).toBe('workshop')
  })
  it('keeps a subfolder of a worktree as it is', () => {
    expect(projectName('/Users/a/code/workshop/.claude/worktrees/x/src')).toBe('src')
  })
  it('never comes back empty', () => {
    expect(projectName('/')).toBe('/')
  })
})
