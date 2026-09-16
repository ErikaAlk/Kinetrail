-- 手表整场汇总里的消耗热量：finalize_workout_session 写入，日历按请求时区的自然日求和。
-- 手表数据不进 Health Connect（用户截图给模型，由模型随训练一起写入），所以它是会话字段而不是新数据集。
ALTER TABLE workout_sessions ADD COLUMN calories_kcal REAL;
