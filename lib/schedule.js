
'use strict';

/*
  node-schedule
  A cron-like and not-cron-like job scheduler for Node.
*/

var events = require('events'),
  util = require('util'),
  cronParser = require('cron-parser'),
  CronDate = require('cron-parser/lib/date'),
  lt = require('long-timeout'),
  sorted = require('sorted-array-functions');

/* Job object */
var anonJobCounter = 0;

function isValidDate(date) {
  // Taken from http://stackoverflow.com/a/12372720/1562178
  // If getTime() returns NaN it'll return false anyway
  return date.getTime() === date.getTime();
}

function Job(name, job, callback) {
  // setup a private pendingInvocations variable
  var pendingInvocations = [];

  //setup a private number of invocations variable
  var triggeredJobs = 0;

  // Set scope vars
  var jobName = name && typeof name === 'string' ? name : '<Anonymous Job ' + (++anonJobCounter) + '>';
  this.job = name && typeof name === 'function' ? name : job;

  // Make sure callback is actually a callback
  if (this.job === name) {
    // Name wasn't provided and maybe a callback is there
    this.callback = typeof job === 'function' ? job : false;
  } else {
    // Name was provided, and maybe a callback is there
    this.callback = typeof callback === 'function' ? callback : false;
  }

  // Check for generator
  if (typeof this.job === 'function' &&
      this.job.prototype &&
      this.job.prototype.next) {
    this.job = function() {
      return this.next().value;
    }.bind(this.job.call(this));
  }

  // define properties
  Object.defineProperty(this, 'name', {
    value: jobName,
    writable: false,
    enumerable: true
  });

  // method that require private access
  this.trackInvocation = function(invocation) {
    // add to our invocation list
    sorted.add(pendingInvocations, invocation, sorter);
    return true;
  };
  this.stopTrackingInvocation = function(invocation) {
    var invIdx = pendingInvocations.indexOf(invocation);
    if (invIdx > -1) {
      pendingInvocations.splice(invIdx, 1);
      return true;
    }

    return false;
  };
  this.triggeredJobs = function() {
    return triggeredJobs;
  };
  this.setTriggeredJobs = function(triggeredJob) {
    triggeredJobs = triggeredJob;
  };
  this.cancel = function(reschedule) {
    reschedule = (typeof reschedule == 'boolean') ? reschedule : false;

    var inv, newInv;
    var newInvs = [];
    for (var j = 0; j < pendingInvocations.length; j++) {
      inv = pendingInvocations[j];

      cancelInvocation(inv);

      if (reschedule && inv.recurrenceRule.recurs) {
        newInv = scheduleNextRecurrence(inv.recurrenceRule, this, inv.fireDate, inv.endDate);
        if (newInv !== null) {
          newInvs.push(newInv);
        }
      }
    }

    pendingInvocations = [];

    for (var k = 0; k < newInvs.length; k++) {
      this.trackInvocation(newInvs[k]);
    }

    // remove from scheduledJobs if reschedule === false
    if (!reschedule) {
      if (this.name) {
        delete scheduledJobs[this.name];
      }
    }

    return true;
  };
  this.cancelNext = function(reschedule) {
    reschedule = (typeof reschedule == 'boolean') ? reschedule : true;

    if (!pendingInvocations.length) {
      return false;
    }

    var newInv;
    var nextInv = pendingInvocations.shift();

    cancelInvocation(nextInv);

    if (reschedule && nextInv.recurrenceRule.recurs) {
      newInv = scheduleNextRecurrence(nextInv.recurrenceRule, this, nextInv.fireDate, nextInv.endDate);
      if (newInv !== null) {
        this.trackInvocation(newInv);
      }
    }

    return true;
  };
  this.reschedule = function(spec, timezone) {
    var inv;
    var cInvs = pendingInvocations.slice();

    for (var j = 0; j < cInvs.length; j++) {
      inv = cInvs[j];

      cancelInvocation(inv);
    }

    pendingInvocations = [];

    if (this.schedule(spec, timezone)) {
      this.setTriggeredJobs(0);
      return true;
    } else {
      pendingInvocations = cInvs;
      return false;
    }
  };
  this.nextInvocation = function() {
    if (!pendingInvocations.length) {
      return null;
    }
    return pendingInvocations[0].fireDate;
  };
  this.pendingInvocations = function() {
    return pendingInvocations;
  };
}

util.inherits(Job, events.EventEmitter);

Job.prototype.invoke = function() {
  if (typeof this.job == 'function') {
    this.setTriggeredJobs(this.triggeredJobs() + 1);
    this.job();
  } else {
    this.job.execute();
  }
};

Job.prototype.runOnDate = function(date) {
  return this.schedule(date);
};

Job.prototype.schedule = function(spec, timezone) {
  var self = this;
  var success = false;
  var inv;
  var start;
  var end;
  var tz = timezone;

  if (typeof spec === 'object' && spec.rule) {
    start = spec.start || undefined;
    end = spec.end || undefined;
    spec = spec.rule;
    tz = spec.tz;

    if (start) {
      if (!(start instanceof Date)) {
        start = new Date(start);
      }

      start = new CronDate(start, tz);
      if (!isValidDate(start) || start.getTime() < Date.now()) {
        start = undefined;
      }
    }

    if (end && !(end instanceof Date) && !isValidDate(end = new Date(end))) {
      end = undefined;
    }

    if (end) {
      end = new CronDate(end, tz);
    }
  }

  try {
    var res = cronParser.parseExpression(spec, { currentDate: start, tz: tz });
    inv = scheduleNextRecurrence(res, self, start, end);
    if (inv !== null) {
      success = self.trackInvocation(inv);
    }
  } catch (err) {
    var type = typeof spec;
    if ((type === 'string') || (type === 'number')) {
      spec = new Date(spec);
    }

    if ((spec instanceof Date) && (isValidDate(spec))) {
      spec = new CronDate(spec);
      if (spec.getTime() >= Date.now()) {
        inv = new Invocation(self, spec);
        scheduleInvocation(inv);
        success = self.trackInvocation(inv);
      }
    } else if (type === 'object') {
      if (!(spec instanceof RecurrenceRule)) {
        var r = new RecurrenceRule();
        if ('year' in spec) {
          r.year = spec.year;
        }
        if ('month' in spec) {
          r.month = spec.month;
        }
        if ('date' in spec) {
          r.date = spec.date;
        }
        if ('dayOfWeek' in spec) {
          r.dayOfWeek = spec.dayOfWeek;
        }
        if ('hour' in spec) {
          r.hour = spec.hour;
        }
        if ('minute' in spec) {
          r.minute = spec.minute;
        }
        if ('second' in spec) {
          r.second = spec.second;
        }

        spec = r;
      }

      spec.tz = tz;
      inv = scheduleNextRecurrence(spec, self, start, end);
      if (inv !== null) {
        success = self.trackInvocation(inv);
      }
    }
  }

  scheduledJobs[this.name] = this;
  return success;
};

/* API
  invoke()
  runOnDate(date)
  schedule(date || recurrenceRule || cronstring)
  cancel(reschedule = false)
  cancelNext(reschedule = true)

   Property constraints
  name: readonly
  job: readwrite
*/

/* DoesntRecur rule */
var DoesntRecur = new RecurrenceRule();
DoesntRecur.recurs = false;

/* Invocation object */
function Invocation(job, fireDate, recurrenceRule, endDate) {
  this.job = job;
  this.fireDate = fireDate;
  this.endDate = endDate;
  this.recurrenceRule = recurrenceRule || DoesntRecur;

  this.timerID = null;
}

function sorter(a, b) {
  return (a.fireDate.getTime() - b.fireDate.getTime());
}

/* Range object */
function Range(start, end, step) {
  this.start = start || 0;
  this.end = end || 60;
  this.step = step || 1;
}

Range.prototype.contains = function(val) {
  if (this.step === null || this.step === 1) {
    return (val >= this.start && val <= this.end);
  } else {
    for (var i = this.start; i < this.end; i += this.step) {
      if (i === val) {
        return true;
      }
    }

    return false;
  }
};

/* RecurrenceRule object */
/*
  Interpreting each property:
  null - any value is valid
  number - fixed value
  Range - value must fall in range
  array - value must validate against any item in list

  NOTE: Cron months are 1-based, but RecurrenceRule months are 0-based.
*/
function RecurrenceRule(year, month, date, dayOfWeek, hour, minute, second) {
  this.recurs = true;

  this.year = (year == null) ? null : year;
  this.month = (month == null) ? null : month;
  this.date = (date == null) ? null : date;
  this.dayOfWeek = (dayOfWeek == null) ? null : dayOfWeek;
  this.hour = (hour == null) ? null : hour;
  this.minute = (minute == null) ? null : minute;
  this.second = (second == null) ? 0 : second;
}

RecurrenceRule.prototype.nextInvocationDate = function(base) {
  base = ((base instanceof CronDate) || (base instanceof Date)) ? base : (new Date());
  if (!this.recurs) {
    return null;
  }

  var now = new CronDate(Date.now(), this.tz);
  var fullYear = now.getFullYear();
  if ((this.year !== null) &&
      (typeof this.year == 'number') &&
      (this.year < fullYear)) {
    return null;
  }

  var next = new CronDate(base.getTime(), this.tz);
  next.addSecond();

  while (true) {
    if (this.year !== null) {
      fullYear = next.getFullYear();
      if ((typeof this.year == 'number') && (this.year < fullYear)) {
        next = null;
        break;
      }

      if (!recurMatch(fullYear, this.year)) {
        next.addYear();
        next.setMonth(0);
        next.setDate(1);
        next.setHours(0);
        next.setMinutes(0);
        next.setSeconds(0);
        continue;
      }
    }
    if (this.month != null && !recurMatch(next.getMonth(), this.month)) {
      next.addMonth();
      continue;
    }
    if (this.date != null && !recurMatch(next.getDate(), this.date)) {
      next.addDay();
      continue;
    }
    if (this.dayOfWeek != null && !recurMatch(next.getDay(), this.dayOfWeek)) {
      next.addDay();
      continue;
    }
    if (this.hour != null && !recurMatch(next.getHours(), this.hour)) {
      next.addHour();
      continue;
    }
    if (this.minute != null && !recurMatch(next.getMinutes(), this.minute)) {
      next.addMinute();
      continue;
    }
    if (this.second != null && !recurMatch(next.getSeconds(), this.second)) {
      next.addSecond();
      continue;
    }

    break;
  }

  return next ? next.toDate() : null;
};

function recurMatch(val, matcher) {
  if (matcher == null) {
    return true;
  }

  if (typeof matcher === 'number') {
    return (val === matcher);
  } else if(typeof matcher === 'string') {
    return (val === Number(matcher));
  } else if (matcher instanceof Range) {
    return matcher.contains(val);
  } else if (Array.isArray(matcher) || (matcher instanceof Array)) {
    for (var i = 0; i < matcher.length; i++) {
      if (recurMatch(val, matcher[i])) {
        return true;
      }
    }
  }

  return false;
}

/* Date-based scheduler */
function runOnDate(date, job) {
  var now = (new Date()).getTime();
  var then = date.getTime();

  if (then < now) {
    setImmediate(job);
    return null;
  }

  return lt.setTimeout(job, (then - now));
}

var invocations = [];
var currentInvocation = null;

function scheduleInvocation(invocation) {
  sorted.add(invocations, invocation, sorter);
  prepareNextInvocation();
  var date = invocation.fireDate instanceof CronDate ? invocation.fireDate.toDate() : invocation.fireDate;
  invocation.job.emit('scheduled', date);
}

function prepareNextInvocation() {
  if (invocations.length > 0 && currentInvocation !== invocations[0]) {
    if (currentInvocation !== null) {
      lt.clearTimeout(currentInvocation.timerID);
      currentInvocation.timerID = null;
      currentInvocation = null;
    }

    currentInvocation = invocations[0];

    var job = currentInvocation.job;
    var cinv = currentInvocation;
    currentInvocation.timerID = runOnDate(currentInvocation.fireDate, function() {
      currentInvocationFinished();

      if (job.callback) {
        job.callback();
      }

      if (cinv.recurrenceRule.recurs || cinv.recurrenceRule._endDate === null) {
        var inv = scheduleNextRecurrence(cinv.recurrenceRule, cinv.job, cinv.fireDate, cinv.endDate);
        if (inv !== null) {
          inv.job.trackInvocation(inv);
        }
      }

      job.stopTrackingInvocation(cinv);

      job.invoke();
      job.emit('run');
    });
  }
}

function currentInvocationFinished() {
  invocations.shift();
  currentInvocation = null;
  prepareNextInvocation();
}

function cancelInvocation(invocation) {
  var idx = invocations.indexOf(invocation);
  if (idx > -1) {
    invocations.splice(idx, 1);
    if (invocation.timerID !== null) {
      lt.clearTimeout(invocation.timerID);
    }

    if (currentInvocation === invocation) {
      currentInvocation = null;
    }

    invocation.job.emit('canceled', invocation.fireDate);
    prepareNextInvocation();
  }
}

/* Recurrence scheduler */
function scheduleNextRecurrence(rule, job, prevDate, endDate) {

  prevDate = (prevDate instanceof CronDate) ? prevDate : new CronDate();

  var date = (rule instanceof RecurrenceRule) ? rule.nextInvocationDate(prevDate) : rule.next();
  if (date === null) {
    return null;
  }

  if ((endDate instanceof CronDate) && date.getTime() > endDate.getTime()) {
    return null;
  }

  var inv = new Invocation(job, date, rule, endDate);
  scheduleInvocation(inv);

  return inv;
}

/* Convenience methods */
var scheduledJobs = {};

function scheduleJob() {
  if (arguments.length < 2) {
    return null;
  }

  var name;
  var spec;
  var timezone;
  var method;
  var callback;

  var funcCnt = 0;
  for(var i = 0; i < arguments.length; i++) {
    if(typeof arguments[i] === 'function') {
      funcCnt++;
    }
  }

  if(funcCnt === 1) {
    method = arguments[arguments.length - 1];
  } else if(funcCnt === 2) {
    method = arguments[arguments.length - 2];
    callback = arguments[arguments.length - 1];
  }
  var strCnt = arguments.length - funcCnt;
  if(strCnt === 1) {
    spec = arguments[0];
  } else if(strCnt === 2) {
    name = arguments[0];
    spec = arguments[1];
  } else if(strCnt === 3) {
    name = arguments[0];
    spec = arguments[1];
    timezone = arguments[2];
  }

  var job = new Job(name, method, callback);

  if (job.schedule(spec, timezone)) {
    return job;
  }

  return null;
}

function rescheduleJob(job, spec, timezone) {
  if (job instanceof Job) {
    if (job.reschedule(spec, timezone)) {
      return job;
    }
  } else if (typeof job == 'string' || job instanceof String) {
    if (job in scheduledJobs && scheduledJobs.hasOwnProperty(job)) {
      if (scheduledJobs[job].reschedule(spec, timezone)) {
        return scheduledJobs[job];
      }
    }
  }
  return null;
}

function cancelJob(job) {
  var success = false;
  if (job instanceof Job) {
    success = job.cancel();
  } else if (typeof job == 'string' || job instanceof String) {
    if (job in scheduledJobs && scheduledJobs.hasOwnProperty(job)) {
      success = scheduledJobs[job].cancel();
    }
  }

  return success;
}

/* Public API */
module.exports.Job = Job;
module.exports.Range = Range;
module.exports.RecurrenceRule = RecurrenceRule;
module.exports.Invocation = Invocation;
module.exports.scheduleJob = scheduleJob;
module.exports.rescheduleJob = rescheduleJob;
module.exports.scheduledJobs = scheduledJobs;
module.exports.cancelJob = cancelJob;
