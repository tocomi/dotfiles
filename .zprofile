# alias
alias cdz="cd ~/dotifiles"
alias ez='vim ~/.zprofile'
alias ezrc='vim ~/.zshrc'
alias sz='source ~/.zprofile && source ~/.zshrc'

alias ll='ls -l'
alias la='ls -al'

alias c='clear'

# git
alias ga='git add -A'
alias gb='git branch'
alias gc='git checkout'
alias gcb='git checkout -b'
alias gcm='git commit -m'
alias gce="git commit --allow-empty -m 'initial commit'"
alias gd='git diff'
alias gf='git fetch --prune'
alias glo='git log --oneline'
alias gm='git merge'
alias gmm='gf && gc main && gm && gc - && gm main'
alias gp='git push origin HEAD'
alias gs='git status'

